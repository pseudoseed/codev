#!/usr/bin/env node
/**
 * Spec 146 — success criterion 12.
 *
 * "The 89 commits to orchestration.ts are classified as breaking or non-breaking
 *  against the vendored types, with the breaking count recorded. Counting commits
 *  is not the criterion."
 *
 * So this does not count commits. For each commit touching the pinned closure it
 * asks a narrower question: **did this change a shape Codev actually consumes?**
 *
 * Method: check out each commit into a detached worktree of the t3code clone,
 * regenerate the artifacts in memory, and diff them against the previous commit's.
 * Three outcomes:
 *
 *   consumed-change   the emitted schema for something we consume changed
 *   source-only       closure source changed, emitted output did not
 *   unrelated         the commit touched the closure but not our schemas
 *
 * `source-only` is NOT "harmless". Because the emitter drops checks behind
 * transforms (see generate.mjs), a relaxed branded id lands here with a zero-byte
 * schema diff. The report says so rather than folding it into a pass, since
 * treating source-only as safe is exactly the mistake the two-layer design exists
 * to prevent.
 *
 * Usage:
 *   node classify-churn.mjs [--since <sha>] [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));
const t3Root = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';

const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '2026-02-07';
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

const git = (...a) => execFileSync('git', ['-C', t3Root, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const closurePaths = pin.closure.map((f) => `${pin.contractsRoot}/${f}`);

const sinceArg = /^[0-9a-f]{7,40}$/.test(since) ? `${since}..HEAD` : `--since=${since}`;
const commits = git('log', '--format=%H|%ad|%s', '--date=short', '--reverse', sinceArg, '--', ...closurePaths)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [sha, date, ...rest] = line.split('|');
    return { sha, date, subject: rest.join('|') };
  })
  .slice(0, limit);

if (commits.length === 0) {
  // Exit 0. An empty range is the NORMAL state right after a refresh — the pin is
  // current and nothing new has landed. Exiting non-zero here made the documented
  // refresh procedure's own step 2 fail whenever it had nothing to report, which
  // is "nothing to do" spelled exactly like "something went wrong".
  console.error('[classify-churn] no commits touch the closure in that range — nothing to classify');
  console.log(JSON.stringify({ range: since, total: 0, counts: {}, rows: [] }, null, 2));
  process.exit(0);
}

console.error(`[classify-churn] classifying ${commits.length} commits touching the closure...`);

/**
 * Emit the closure's consumed schemas at one commit, without touching the
 * working tree of the clone: `git show` each file into a temp dir and import it.
 */
const SR = await import('effect/SchemaRepresentation');

async function emitAt(sha) {
  // Staged INSIDE this tool, not in /tmp: Node resolves `effect` by walking up
  // from the importing file, and from /tmp that walk finds nothing. Staging in
  // the system temp dir makes every commit look unbuildable, which reads as
  // "nothing to classify" rather than "the harness is broken".
  const dir = mkdtempSync(join(here, '.churn-'));
  try {
    for (const file of pin.closure) {
      let content;
      try {
        content = git('show', `${sha}:${pin.contractsRoot}/${file}`);
      } catch {
        return { error: `file ${file} absent at ${sha.slice(0, 8)}` };
      }
      writeFileSync(join(dir, file), content);
    }
    const orchestration = await import(`${pathToFileURL(join(dir, 'orchestration.ts')).href}?t=${sha}`);
    const gitMod = await import(`${pathToFileURL(join(dir, 'git.ts')).href}?t=${sha}`);
    const out = {};
    const rpcMap = orchestration.OrchestrationRpcSchemas;
    for (const [method, spec] of Object.entries(pin.methods)) {
      if (method.startsWith('_')) continue;
      try {
        if (spec.source === 'OrchestrationRpcSchemas') {
          const entry = rpcMap?.[spec.key];
          if (!entry) { out[method] = '<method absent>'; continue; }
          const doc = (s) => JSON.stringify(SR.toJsonSchemaDocument(SR.toRepresentation(s.ast)).schema ?? {});
          out[method] = doc(entry.input) + '|' + doc(entry.output);
        } else {
          const doc = (n) => (n && gitMod[n] ? JSON.stringify(SR.toJsonSchemaDocument(SR.toRepresentation(gitMod[n].ast)).schema ?? {}) : '<absent>');
          out[method] = doc(spec.input) + '|' + doc(spec.output);
        }
      } catch (error) {
        out[method] = `<error ${String(error).slice(0, 60)}>`;
      }
    }
    return { schemas: out };
  } catch (error) {
    return { error: String(error && error.stack ? error.stack.split('\n').slice(0,4).join(' | ') : error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sourceOf(sha) {
  const parts = {};
  for (const file of pin.closure) {
    try {
      parts[file] = git('show', `${sha}:${pin.contractsRoot}/${file}`);
    } catch {
      parts[file] = null;
    }
  }
  return parts;
}


/**
 * Classify a schema change as breaking or non-breaking FOR A CLIENT.
 *
 * Criterion 12 asks for breaking/non-breaking, and an earlier version of this
 * tool answered a different question: it reported every emitted-schema change as
 * "the breaking count". That is a superset. Adding an optional field changes the
 * emitted schema and breaks nobody. Codex caught the conflation in review and was
 * right; the count it produced was an upper bound wearing a precise name.
 *
 * Breaking, from the perspective of a client Codev writes:
 *   - a property we send stops being accepted (removed from properties)
 *   - a property becomes required that was not
 *   - a type narrows (string -> integer), or an enum loses a member
 *   - additionalProperties tightens to false
 * Non-breaking:
 *   - a new optional property appears
 *   - an enum gains a member
 *   - descriptions, titles, ordering
 *
 * Anything this cannot decide is returned as `unknown` rather than guessed. The
 * whole point of the exercise is not to spell "I could not tell" like "fine".
 */
function classifyChange(before, after) {
  const reasons = [];
  let unknown = false;

  const walk = (a, b, path) => {
    if (a === undefined || b === undefined) return;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
      if (JSON.stringify(a) !== JSON.stringify(b)) reasons.push(`${path}: value changed`);
      return;
    }

    if (a.type !== b.type && (a.type || b.type)) {
      reasons.push(`${path}: type ${a.type ?? '?'} -> ${b.type ?? '?'}`);
    }

    if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
      const removed = a.enum.filter((v) => !b.enum.includes(v));
      if (removed.length) reasons.push(`${path}: enum lost ${JSON.stringify(removed)}`);
    }

    const aReq = new Set(a.required ?? []);
    const bReq = new Set(b.required ?? []);
    for (const key of bReq) if (!aReq.has(key)) reasons.push(`${path}/${key}: became required`);

    const aProps = a.properties ?? {};
    const bProps = b.properties ?? {};
    for (const key of Object.keys(aProps)) {
      if (!(key in bProps)) reasons.push(`${path}/${key}: property removed`);
      else walk(aProps[key], bProps[key], `${path}/${key}`);
    }

    if (a.additionalProperties !== false && b.additionalProperties === false) {
      reasons.push(`${path}: additionalProperties tightened to false`);
    }

    // Unions are where this classifier stops being confident. Rather than
    // pretending, mark the whole comparison unknown.
    if (Array.isArray(a.anyOf) || Array.isArray(b.anyOf) || Array.isArray(a.oneOf) || Array.isArray(b.oneOf)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) unknown = true;
    }
  };

  try {
    walk(before, after, '');
  } catch {
    unknown = true;
  }

  if (reasons.length > 0) return { verdict: 'breaking', reasons: reasons.slice(0, 4) };
  if (unknown) return { verdict: 'unknown', reasons: ['union shape changed; not decidable here'] };
  return { verdict: 'non-breaking', reasons: [] };
}

const rows = [];
let previous = null;
let previousSource = null;

for (const [index, commit] of commits.entries()) {
  const emitted = await emitAt(commit.sha);
  const source = sourceOf(commit.sha);

  let verdict;
  let detail = '';

  if (emitted.error) {
    // NOT "this commit is broken". It means the PINNED Effect cannot represent
    // that commit's contracts — usually because the commit predates the Effect
    // version we generate with. That is "could not classify", a third answer,
    // and it must not be counted as either breaking or safe.
    verdict = 'unclassifiable';
    detail = emitted.error;
  } else if (previous === null) {
    verdict = 'baseline';
  } else {
    const changedMethods = Object.keys(emitted.schemas).filter((m) => emitted.schemas[m] !== previous[m]);
    const sourceChanged = pin.closure.some((f) => source[f] !== previousSource[f]);
    if (changedMethods.length > 0) {
      // Split consumed-change into breaking / non-breaking / undecidable rather
      // than calling the whole set "breaking".
      const verdicts = changedMethods.map((m) => {
        const [beforeIn, beforeOut] = String(previous[m]).split('|');
        const [afterIn, afterOut] = String(emitted.schemas[m]).split('|');
        const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
        const a = classifyChange(parse(beforeIn), parse(afterIn));
        const b = classifyChange(parse(beforeOut), parse(afterOut));
        const worst = [a, b].find((v) => v.verdict === 'breaking')
          ?? [a, b].find((v) => v.verdict === 'unknown') ?? a;
        return { method: m, ...worst };
      });
      const anyBreaking = verdicts.some((v) => v.verdict === 'breaking');
      const anyUnknown = verdicts.some((v) => v.verdict === 'unknown');
      verdict = anyBreaking ? 'breaking' : anyUnknown ? 'consumed-change-undecidable' : 'non-breaking';
      detail = verdicts.map((v) => `${v.method}: ${v.verdict}${v.reasons.length ? ' (' + v.reasons[0] + ')' : ''}`).join('; ');
    } else if (sourceChanged) {
      verdict = 'source-only';
      detail = pin.closure.filter((f) => source[f] !== previousSource[f]).join(', ');
    } else {
      verdict = 'unrelated';
    }
  }

  rows.push({ ...commit, verdict, detail });
  if (!emitted.error) {
    previous = emitted.schemas;
    previousSource = source;
  }
  if ((index + 1) % 20 === 0) console.error(`  ...${index + 1}/${commits.length}`);
}

const counts = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});

console.log(JSON.stringify({ range: since, total: rows.length, counts, rows }, null, 2));
console.error(`[classify-churn] ${JSON.stringify(counts)}`);

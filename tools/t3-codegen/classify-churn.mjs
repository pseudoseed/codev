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
  console.error('[classify-churn] no commits touch the closure in that range');
  process.exit(1);
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
      verdict = 'consumed-change';
      detail = changedMethods.join(', ');
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

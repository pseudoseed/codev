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
 * ---------------------------------------------------------------------------
 * Spec 250 — two ranges, two checkouts, two questions.
 *
 * "What has upstream done since we pinned it?" and "what have we changed?" are
 * not the same question, and answering them from one range reports our own
 * customization as upstream movement. So the mode is mandatory:
 *
 *   --upstream-movement   upstreamBase..origin/main, read from the upstream clone
 *   --fork-drift          upstreamBase..<fork head>, read from the fork checkout
 *
 * Invoked with neither, it fails. Invoked with both, it fails. There is no
 * default, because the wrong default here produces a plausible-looking answer to
 * a question nobody asked.
 *
 * Usage:
 *   node classify-churn.mjs (--upstream-movement | --fork-drift) [--since <sha>] [--limit N]
 *
 * Exit codes: 0 ok (including "nothing to classify"), 1 bad invocation,
 * 3 "could not determine" — a missing checkout or an unresolvable ref.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHURN_MODES, MISMATCH, UNDETERMINED, churnRange, resolveIdentities } from '../t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));
const identities = resolveIdentities(pin);

const args = process.argv.slice(2);

const selected = Object.keys(CHURN_MODES).filter((m) => args.includes(`--${m}`));
if (selected.length !== 1) {
  console.error(
    `[classify-churn] ${selected.length === 0 ? 'no mode given' : `${selected.length} modes given`}. ` +
      `Pass exactly one of ${Object.keys(CHURN_MODES).map((m) => `--${m}`).join(' or ')}.\n` +
      `  --upstream-movement  what pingdotgg/t3code did since ${identities.upstream.commit.slice(0, 12)}\n` +
      `  --fork-drift         what our private customization changed\n` +
      `They read different checkouts and mean different things; there is no default.`,
  );
  process.exit(MISMATCH);
}

const range = churnRange(selected[0], identities);
const t3Root = range.root;

if (!existsSync(t3Root)) {
  console.error(
    `[classify-churn] COULD_NOT_TELL: no ${range.identity} checkout at ${t3Root}. ` +
      `Nothing was classified, and that is not the same as nothing having changed.`,
  );
  process.exit(UNDETERMINED);
}

const git = (...a) => execFileSync('git', ['-C', t3Root, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const closurePaths = pin.closure.map((f) => `${pin.contractsRoot}/${f}`);

const sinceIdx = args.indexOf('--since');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

// `--since` narrows the mode's range; it does not replace it. Overriding the
// start of an --upstream-movement range is a legitimate thing to want; silently
// letting it also change WHICH checkout is read is not.
const from = sinceIdx >= 0 ? args[sinceIdx + 1] : range.from;
const rangeSpec = `${from}..${range.to}`;

// Resolved AFTER `--since` is applied, so the guard covers the refs actually
// used. Checking `range.from` here instead would let an unresolvable `--since`
// past it and surface as a raw git error, which is exit 1 wearing exit 3's job.
for (const ref of [from, range.to]) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    console.error(
      `[classify-churn] COULD_NOT_TELL: ${ref} does not resolve in ${t3Root}. ` +
        `An unreadable ref is "unknown", not "no movement".`,
    );
    process.exit(UNDETERMINED);
  }
}

const commits = git('log', '--format=%H|%ad|%s', '--date=short', '--reverse', rangeSpec, '--', ...closurePaths)
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
  //
  // The signal names the mode, so "upstream has not moved" and "we have not
  // customized anything yet" stay two readable answers rather than one blank one.
  const signal = selected[0] === 'upstream-movement' ? 'NO_UPSTREAM_MOVEMENT' : 'NO_FORK_DRIFT';
  console.error(`[classify-churn] ${signal}: no commits touch the closure in ${rangeSpec} — nothing to classify`);
  console.log(JSON.stringify({
    mode: selected[0], identity: range.identity, root: t3Root, range: rangeSpec,
    signal, total: 0, counts: {}, rows: [],
  }, null, 2));
  process.exit(0);
}

console.error(
  `[classify-churn] ${selected[0]}: classifying ${commits.length} commits touching the closure ` +
    `in ${rangeSpec} (${range.identity} checkout ${t3Root})...`,
);

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
 * DIRECTION MATTERS, and an earlier version ignored it — codex caught that too.
 * For an INPUT (what Codev sends) a narrowed type or a newly-required property
 * breaks us. For an OUTPUT (what the server sends back) the opposite is true: a
 * *widened* type or a *removed* required property breaks us, because we read
 * fields we were promised. Applying input rules to outputs produced a count that
 * was wrong in both directions at once.
 *
 * Anything this cannot decide is returned as `unknown` rather than guessed. The
 * whole point of the exercise is not to spell "I could not tell" like "fine".
 */
function classifyChange(before, after, direction) {
  const reasons = [];
  let unknown = false;

  const walk = (a, b, path) => {
    if (a === undefined || b === undefined) return;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
      if (JSON.stringify(a) !== JSON.stringify(b)) reasons.push(`${path}: value changed`);
      return;
    }

    // A type change breaks whoever depends on the old type being honoured. On an
    // input that is us (we send the old type); on an output that is also us (we
    // read the old type). So a change breaks either way — but the DIRECTION
    // decides for the asymmetric rules below.
    if (a.type !== b.type && (a.type || b.type)) {
      reasons.push(`${path}: type ${a.type ?? '?'} -> ${b.type ?? '?'}`);
    }

    if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
      if (direction === 'input') {
        // A value we might send is no longer accepted.
        const removed = a.enum.filter((v) => !b.enum.includes(v));
        if (removed.length) reasons.push(`${path}: enum lost ${JSON.stringify(removed)}`);
      } else {
        // A value we must now handle that we did not have to before.
        const added = b.enum.filter((v) => !a.enum.includes(v));
        if (added.length) reasons.push(`${path}: enum gained ${JSON.stringify(added)} we must handle`);
      }
    }

    const aReq = new Set(a.required ?? []);
    const bReq = new Set(b.required ?? []);
    if (direction === 'input') {
      // We must now send something we did not send before.
      for (const key of bReq) if (!aReq.has(key)) reasons.push(`${path}/${key}: became required`);
    } else {
      // We were promised a field and no longer are; code that reads it breaks.
      for (const key of aReq) if (!bReq.has(key)) reasons.push(`${path}/${key}: no longer guaranteed`);
    }

    const aProps = a.properties ?? {};
    const bProps = b.properties ?? {};
    for (const key of Object.keys(aProps)) {
      if (!(key in bProps)) reasons.push(`${path}/${key}: property removed`);
      else walk(aProps[key], bProps[key], `${path}/${key}`);
    }

    // Only meaningful for inputs: the server now rejects extra fields we send.
    if (direction === 'input' && a.additionalProperties !== false && b.additionalProperties === false) {
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

/**
 * Seed the comparison from the range's START commit.
 *
 * `git log from..to` EXCLUDES `from`, so without this the first commit in the
 * range has nothing to diff against and is reported as `baseline` — a placeholder,
 * not a verdict. For `--fork-drift` that is the whole answer: with a single
 * customization commit the tool reported "baseline" and no drift, on the one
 * question it exists to answer.
 *
 * `from` is a real commit in both modes (`upstreamBase`, or whatever `--since`
 * named), so comparing the first row against it is the comparison the range
 * already implies. Skipped when `--since` was given a DATE rather than a sha:
 * there is no commit to emit at, and guessing one would be worse than the
 * baseline row.
 */
if (/^[0-9a-f]{7,40}$/.test(from)) {
  const seed = await emitAt(from);
  if (seed.error) {
    console.error(
      `[classify-churn] could not emit at range start ${from.slice(0, 12)} (${seed.error}); ` +
        `the first commit will be reported as \`baseline\` rather than compared.`,
    );
  } else {
    previous = seed.schemas;
    previousSource = sourceOf(from);
  }
}

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
        const a = classifyChange(parse(beforeIn), parse(afterIn), 'input');
        const b = classifyChange(parse(beforeOut), parse(afterOut), 'output');
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

console.log(JSON.stringify({
  mode: selected[0], identity: range.identity, root: t3Root, range: rangeSpec,
  total: rows.length, counts, rows,
}, null, 2));
console.error(`[classify-churn] ${JSON.stringify(counts)}`);

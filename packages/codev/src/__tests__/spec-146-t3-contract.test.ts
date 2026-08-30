/**
 * Spec 146, Phase 1 — the vendored t3code contract.
 *
 * These live in `packages/codev` rather than `packages/types` because that is
 * where the suite actually runs: the root `test` script is
 * `pnpm --filter @cluesmith/codev test`, and `packages/types` has no test
 * runner. A test placed in `packages/types` would look present and never
 * execute, which is the exact failure mode this spec keeps guarding against.
 */

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const typesRoot = join(repoRoot, 'packages', 'types');
const t3Root = join(typesRoot, 'src', 't3');
const generated = join(t3Root, 'generated');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * `schema.json` is a document: `{ $defs, schemas }`. It carries `$defs` because
 * the roots are full of `$ref`s into them — an earlier version emitted the roots
 * alone and left 105 dangling refs.
 */
const readSchemas = () => readJson(join(generated, 'schema.json')).schemas as Record<string, any>;

/**
 * Is a pinned t3code checkout available?
 *
 * The plan requires the live-server-dependent tests to be a SUITE separate from
 * the unit tests, whose absence reports as "skipped for no server" and never as
 * a pass. This constant is that separation: the suite below is gated at the
 * `describe` level, so with no checkout vitest prints one skipped *suite* rather
 * than a green run that silently verified nothing.
 */
const T3_ROOT = process.env.T3CODE_ROOT ?? '';
const HAS_CHECKOUT = T3_ROOT !== '' && existsSync(join(T3_ROOT, 'packages', 'contracts', 'src'));

/**
 * Spec 250 adds a second checkout, so `T3CODE_ROOT` alone no longer says which
 * tree a live assertion is about. `T3_ROOT` keeps its spec 146 meaning — the
 * UPSTREAM clone at `upstreamBase` — and the fork gets its own variable and its
 * own gate. Two questions, two skips: a run with only the upstream checkout must
 * report the fork suite as skipped rather than passing it by comparing upstream
 * to itself.
 */
const T3_FORK_ROOT = process.env.T3CODE_FORK_ROOT ?? '';
const HAS_FORK_CHECKOUT =
  T3_FORK_ROOT !== '' && existsSync(join(T3_FORK_ROOT, 'packages', 'contracts', 'src'));

describe('spec 146: packages/types stays dependency-free', () => {
  it('declares no runtime dependencies', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    // `effect` belongs to the codegen tool alone. If it ever appears here the
    // #1189 boundary is gone and every consumer of the sdk inherits a runtime dep.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('has no source file under src/t3 importing effect', () => {
    for (const file of ['index.ts', 'shape-check.ts', 'generated/schema.ts']) {
      const src = readFileSync(join(t3Root, file), 'utf8');
      expect(src, `${file} must not import effect`).not.toMatch(/from ['"]effect/);
    }
  });

  it('exposes the ./t3 subpath, without which nothing here is importable', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    expect(pkg.exports['./t3']).toBeDefined();
  });
});

describe('spec 146: generated artifacts are present and self-describing', () => {
  const required = [
    'schema.ts',
    'schema.json',
    'methods.json',
    'source-hash.json',
    'types.d.ts',
    'LOSSY.md',
    'UNREPRESENTED.md',
    'ATTRIBUTION.md',
  ];

  it.each(required)('emits %s', (name) => {
    expect(existsSync(join(generated, name))).toBe(true);
  });

  it('carries the MIT notice, because these artifacts ship inside an Apache-2.0 package', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    // The obligation only exists because the package is published and ships src/.
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.files).toContain('src');

    const attribution = readFileSync(join(generated, 'ATTRIBUTION.md'), 'utf8');
    expect(attribution).toContain('MIT License');
    expect(attribution).toContain(readJson(join(t3Root, 'pin.json')).commit);
  });

  it('pins every closure file with a hash', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const hashes = readJson(join(generated, 'source-hash.json'));
    expect(Object.keys(hashes.files).sort()).toEqual([...pin.closure].sort());
    expect(hashes.commit).toBe(pin.commit);
    for (const [file, digest] of Object.entries(hashes.files)) {
      expect(digest, `${file} hash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('maps every pinned method to a schema that exists', () => {
    const methods = readJson(join(generated, 'methods.json'));
    const schemas = readSchemas();
    expect(Object.keys(methods).length).toBeGreaterThan(0);
    for (const [method, spec] of Object.entries<Record<string, string | null>>(methods)) {
      if (spec.input) expect(schemas[spec.input as string], `${method} input`).toBeDefined();
      if (spec.output) expect(schemas[spec.output as string], `${method} output`).toBeDefined();
    }
  });
});

describe('spec 146: the emitter is lossy, and says so', () => {
  /**
   * This is the finding that shaped Phase 1. `toJsonSchemaDocument` drops checks
   * applied on the decoded side of a `decodeTo` transform, so every branded id
   * degrades to an unconstrained string. If LOSSY.md is ever empty, either the
   * detector broke or upstream changed — and both need a human, because an empty
   * LOSSY.md silently promotes the shape check into something it is not.
   */
  it('records the degraded schemas rather than reporting a clean bill', () => {
    const lossy = readFileSync(join(generated, 'LOSSY.md'), 'utf8');
    expect(lossy).toContain('TrimmedNonEmptyString');
    expect(lossy).toContain('ThreadId');
    expect(lossy).not.toContain('_None detected.');
  });

  it('shows branded ids emitting as bare strings in the schema itself', () => {
    const worktree = readSchemas().VcsCreateWorktreeInput;
    // `cwd` is TrimmedNonEmptyString upstream; here it is an unconstrained string.
    // Asserting the weakness keeps anyone from "fixing" the docs to claim otherwise.
    expect(worktree.properties.cwd).toEqual({ type: 'string' });
  });
});

/**
 * LIVE SUITE — requires a pinned t3code checkout. Skipped as a whole when there
 * is none, so its absence is legible in the run output instead of disappearing
 * into a green unit run.
 */
describe.skipIf(!HAS_CHECKOUT)(`spec 146 [live: needs upstream t3code checkout at ${T3_ROOT || '$T3CODE_ROOT (unset)'}]`, () => {
  /**
   * Spec 250: this compares the UPSTREAM section against the UPSTREAM clone.
   *
   * Before the fork existed, `hashes.files` and this checkout were the same tree,
   * so one assertion covered both. `hashes.files` is now the fork's closure, and
   * checking it here would start failing the moment we customize anything — and,
   * worse, would report our own deliberate change as upstream drift.
   */
  it('upstream hashes match the upstream checkout at upstreamBase', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const contracts = join(T3_ROOT, pin.contractsRoot);
    const hashes = readJson(join(generated, 'source-hash.json'));

    expect(
      hashes.upstream?.available,
      `source-hash.json records no upstream measurement (${hashes.upstream?.reason ?? 'no reason given'}); ` +
        'regenerate with the upstream clone present rather than treating an unmeasured section as a match',
    ).toBe(true);
    expect(hashes.upstream.commit).toBe(pin.upstreamBase);

    for (const [file, expected] of Object.entries<string>(hashes.upstream.files)) {
      const actual = createHash('sha256').update(readFileSync(join(contracts, file))).digest('hex');
      expect(actual, `${file} drifted from the recorded upstream hash`).toBe(expected);
    }
  });
});

describe.skipIf(!HAS_FORK_CHECKOUT)(`spec 250 [live: needs fork checkout at ${T3_FORK_ROOT || '$T3CODE_FORK_ROOT (unset)'}]`, () => {
  it('generated hashes match the fork checkout the artifacts came from', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const contracts = join(T3_FORK_ROOT, pin.contractsRoot);
    const hashes = readJson(join(generated, 'source-hash.json'));
    expect(hashes.commit).toBe(pin.commit);
    for (const [file, expected] of Object.entries<string>(hashes.files)) {
      const actual = createHash('sha256').update(readFileSync(join(contracts, file))).digest('hex');
      expect(actual, `${file} drifted from the pinned hash`).toBe(expected);
    }
  });
});

describe('spec 146: source-hash is the drift detector the schema cannot be', () => {

  /**
   * The plan's acceptance criterion for the two-layer design: mutate
   * `TrimmedNonEmptyString` to drop its `isNonEmpty` check, and assert the
   * source-hash layer fires while the generated diff stays empty.
   *
   * The probe runs under Node 22 with `effect` (it must emit schemas), which the
   * suite does not, so the measurement is recorded and asserted here. Reproduce:
   *
   *   PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
   *     node tools/t3-codegen/transform-blindness-probe.mjs
   */
  it('has recorded evidence that the generated layer alone would miss it', () => {
    const evidencePath = join(repoRoot, 'codev', 'research', '146-transform-blindness-evidence.json');
    const evidence = readJson(evidencePath);

    expect(evidence.ok, 'probe could not run; the recorded evidence is stale').toBe(true);
    expect(evidence.mutation).toContain('isNonEmpty');

    // The whole justification for the second layer, in two assertions.
    expect(evidence.schemaChanged, 'if this is true the emitter improved — revisit the design').toBe(false);
    expect(evidence.hashChanged, 'if this is false BOTH drift layers are broken').toBe(true);
    expect(evidence.verdict).toContain('CONFIRMED');
  });

  it('would not notice a relaxed branded id in the generated schema alone', () => {
    // The regression guard for the whole two-layer design. `TrimmedNonEmptyString`
    // and an unconstrained trimmed string emit the identical document, so a change
    // removing `isNonEmpty` upstream produces a zero-byte diff in schema.json.
    // Only the source hash can catch it. If this ever fails, the emitter improved
    // and the second layer can be reconsidered — until then it is load-bearing.
    const schemas = readSchemas();
    const bareString = JSON.stringify({ type: 'string' });
    const idFields = [
      schemas.VcsCreateWorktreeInput.properties.cwd,
      schemas.VcsCreateWorktreeInput.properties.refName,
    ];
    for (const field of idFields) {
      expect(JSON.stringify(field)).toBe(bareString);
    }
  });
});

describe('spec 146: the harness criterion that gates Phase 2', () => {
  /**
   * The plan makes this explicit: "Phase 2 does not start until this passes,
   * since every one of its acceptance criteria assumes it."
   *
   * The proof needs a live server and Node 22, which this suite has neither of,
   * so the run is recorded and asserted here. Reproduce:
   *
   *   PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
   *     node tools/t3-server/smoke.mjs --runs 2
   */
  const evidence = readJson(join(repoRoot, 'codev', 'research', '146-harness-coldstart-evidence.json'));

  it('ran twice, not once — a single run cannot show teardown works', () => {
    expect(evidence.runs.length).toBeGreaterThanOrEqual(2);
  });

  it('dispatched a real command and got Success, not merely an open port', () => {
    for (const run of evidence.runs) {
      expect(run.dispatchExit, `run ${run.run}`).toBe('Success');
      expect(run.dispatchSucceeded, `run ${run.run}`).toBe(true);
    }
  });

  it('left no port bound after teardown, so the second run was genuinely cold', () => {
    // Without this the start-twice proof proves nothing: run 2 would just be
    // talking to the server run 1 left behind.
    for (const run of evidence.runs) {
      expect(run.portFreeAfterStop, `run ${run.run}`).toBe(true);
    }
  });

  it('was run against the commit this repo pins', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    expect(evidence.pinnedCommit).toBe(pin.commit);
    expect(evidence.pinnedCliVersion).toBe(pin.cliVersion);
    for (const run of evidence.runs) {
      expect(run.serverRuntime.cliVersion).toBe(pin.cliVersion);
    }
  });

  it('passed every run', () => {
    expect(evidence.allRunsPassed).toBe(true);
  });

  /**
   * Recorded evidence can outlive the code it describes. Review pushed twice on
   * tests that assert committed JSON, and it is a fair objection: nothing stops
   * the harness changing while the evidence stays green.
   *
   * Executing the harness here would need an explicit server interpreter and a
   * live checkout inside a unit suite, which is the wrong place for it. What this CAN do is
   * refuse to accept evidence older than the code it is evidence for.
   */
  it('is not older than the harness it describes', () => {
    const evidencePath = join(repoRoot, 'codev', 'research', '146-harness-coldstart-evidence.json');
    const evidenceAge = statSync(evidencePath).mtimeMs;
    for (const source of ['t3-server.mjs', 'smoke.mjs']) {
      const sourceAge = statSync(join(repoRoot, 'tools', 't3-server', source)).mtimeMs;
      expect(
        evidenceAge,
        `${source} changed after the cold-start evidence was recorded — regenerate it with\n` +
          `  export T3_NODE=/absolute/path/to/node\n` +
          `  "$T3_NODE" tools/t3-server/smoke.mjs --runs 2 > ` +
          `codev/research/146-harness-coldstart-evidence.json\n` +
          `rather than trusting a stale result. The redirection is part of the command: smoke.mjs ` +
          `prints to stdout and writes nothing, so running it without one re-runs the whole cold ` +
          `start and leaves the evidence exactly as stale as it was.`,
      ).toBeGreaterThanOrEqual(sourceAge - 1000);
    }
  });
});

describe('spec 146: tooling distinguishes "nothing to do" from "it failed"', () => {
  /**
   * Eighth instance of this project's recurring defect, caught by running the
   * documented refresh procedure rather than trusting that I had written it
   * correctly. REFRESH.md step 2 classifies churn since the current pin — and at
   * the pin that range is empty, which is the NORMAL state right after a refresh.
   * The classifier exited 1, so the documented step failed whenever it had
   * nothing to report.
   *
   * Asserted at the source rather than by running the tool, which needs Node 22
   * and a checkout that this suite has neither of.
   */
  it('the churn classifier exits 0 on an empty range', () => {
    const src = readFileSync(
      join(repoRoot, 'tools', 't3-codegen', 'classify-churn.mjs'),
      'utf8',
    );
    // Spec 250 gave the empty result a mode-specific signal, so the message names
    // the range rather than saying "that range". The property under test is
    // unchanged: an empty range exits 0.
    const emptyBranch = /no commits touch the closure in \$\{rangeSpec\}[\s\S]{0,600}?process\.exit\((\d)\)/.exec(src);
    expect(emptyBranch, 'the empty-range branch should still exist').not.toBeNull();
    expect(emptyBranch?.[1], 'an empty range is not a failure').toBe('0');
  });

  it('the harness keeps a third exit code for "could not determine"', () => {
    // 0 verified, 1 mismatch, 3 could-not-determine. Collapsing 3 into either of
    // the others is what makes a missing checkout read as a passing check.
    //
    // Spec 250 moved the constants into `tools/t3-fork/identities.mjs` so both
    // checkout identities spell them the same way. The assertion follows them
    // there and additionally pins that the harness uses the shared definition
    // rather than redeclaring its own.
    const shared = readFileSync(join(repoRoot, 'tools', 't3-fork', 'identities.mjs'), 'utf8');
    expect(shared).toMatch(/export const UNDETERMINED = 3/);
    expect(shared).toMatch(/export const MISMATCH = 1/);

    const src = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    expect(src).toMatch(/UNDETERMINED[\s\S]{0,120}from '\.\.\/t3-fork\/identities\.mjs'/);
    expect(src).toMatch(/die\(\s*UNDETERMINED/);
  });

  it('pins the server CLI next to the checkout and never resolves latest', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const src = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    // Intentional tripwire: a pin bump must update and re-verify the recorded CLI.
    expect(pin.cliVersion).toBe('0.0.36');
    expect(src).toContain('`t3@${pin.cliVersion}`');
    expect(src).not.toContain("'t3@latest'");
  });

  it('names interpreter, startup, and checkout-movement failures differently', () => {
    const src = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    for (const signal of ['NO_INTERPRETER', 'SERVER_START_FAILED', 'CHECKOUT_MOVED_DURING_RUN']) {
      expect(src).toContain(signal);
    }
  });

  it('requires an explicit interpreter but treats engines.node as advisory', () => {
    const checkout = mkdtempSync(join(tmpdir(), 't3-runtime-'));
    const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
    try {
      const noInterpreterEnv = { ...process.env, T3CODE_ROOT: checkout };
      delete noInterpreterEnv.T3_NODE;
      const missing = spawnSync(process.execPath, [harness, 'runtime'], {
        encoding: 'utf8', env: noInterpreterEnv,
      });
      expect(missing.status).toBe(3);
      expect(missing.stderr).toContain('NO_INTERPRETER: could not check:');

      const incomplete = spawnSync(process.execPath, [harness, 'runtime'], {
        encoding: 'utf8', env: { ...process.env, T3CODE_ROOT: checkout, T3_NODE: process.execPath },
      });
      expect(incomplete.status).toBe(3);
      expect(incomplete.stderr).toContain('CHECKOUT_UNAVAILABLE: could not check:');

      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ engines: { node: '^99.0.0' } }));
      const explicit = spawnSync(process.execPath, [harness, 'runtime'], {
        encoding: 'utf8', env: { ...process.env, T3CODE_ROOT: checkout, T3_NODE: process.execPath },
      });
      expect(explicit.status).toBe(0);
      expect(JSON.parse(explicit.stdout).matchesDeclaredEngine).toBe(false);
      expect(explicit.stderr).toContain('ADVISORY:');
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  /**
   * Issue #219. `stop` then `start` is not a restart: `start` wipes the data dir,
   * so the pair is a cold start wearing a restart's shape. Spec 146 phase 9's item
   * 4 — "an architect thread survives a server restart" — cannot be evaluated
   * against that at all, because the harness deletes the thread and the result
   * reads as the criterion failing.
   */
  it('separates a restart from a cold start, and refuses to fake one', () => {
    const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
    const src = readFileSync(harness, 'utf8');
    // `start` still wipes by default: the phase-1 cold-start evidence is only
    // evidence if each run begins with an empty database.
    expect(src).toContain('function start({ keepData = false } = {})');
    expect(src).toContain('start({ keepData: true })');

    // And a restart exits "could not determine" rather than quietly cold-starting,
    // which would report the wipe as the thread's fate. Two ways it refuses, and
    // the first is the one a data dir cannot rule out: `stop` LEAVES the data dir,
    // so its presence is not evidence that anything is running. Checking only for
    // it meant `stop` then `restart` succeeded having replaced no process at all —
    // a restart reported, not performed.
    const emptyDir = mkdtempSync(join(tmpdir(), 't3-restart-'));
    try {
      const refused = spawnSync(process.execPath, [harness, 'restart'], {
        encoding: 'utf8',
        // A port nothing is listening on, so "no server is running" is the true state.
        env: { ...process.env, T3_HARNESS_DIR: emptyDir, T3_HARNESS_PORT: '3897' },
      });
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain('NOT_RUNNING: could not check:');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
    // Both refusals are distinct signals, and neither is spelled like a success.
    expect(src).toContain('NOT_RUNNING: could not check:');
    expect(src).toContain('NO_DATA_TO_KEEP: could not check:');
    expect(src).toContain('PORT_NOT_RELEASED: could not check:');
  });

  /**
   * Issue #219 round 3. `stop` signalled whatever the pid file named, and the check
   * behind that was `process.kill(pid, 0)` — LIVENESS, not ownership. Pids are reused,
   * so a stale pid file could name an unrelated live process, and `stop` would SIGTERM
   * its whole process group. `ownsProcess` already existed for the port sweep, which
   * refuses to kill what it cannot prove it owns; the pid path was the one place that
   * rule was not applied, and it is the one that can kill someone else's work.
   */
  it('refuses to signal a live pid it cannot prove it owns', () => {
    const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
    const runtimeDir = mkdtempSync(join(tmpdir(), 't3-ownership-'));
    // A real, live process that is emphatically not a pinned t3code server.
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    try {
      expect(bystander.pid).toBeDefined();
      writeFileSync(join(runtimeDir, 'server.pid'), String(bystander.pid));

      const stopped = spawnSync(process.execPath, [harness, 'stop'], {
        encoding: 'utf8',
        env: { ...process.env, T3_HARNESS_DIR: runtimeDir, T3_HARNESS_PORT: '3898' },
      });

      expect(stopped.stderr).toContain(`REFUSING to signal pid ${bystander.pid}`);
      // The assertion that matters: it is still alive. `kill(pid, 0)` throws only when
      // the process is gone, so this is a direct observation rather than a proxy.
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
      // And the stale file is cleared, so the workspace is not wedged by it forever.
      expect(existsSync(join(runtimeDir, 'server.pid'))).toBe(false);
    } finally {
      try { process.kill(bystander.pid!, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  /**
   * Issue #219 round 4. `ownedPortHolders` caught every `lsof` failure and returned an
   * empty list, so a tool that could not look read exactly like a port with nothing on
   * it. `restart` then started a second server on a port whose state was unknown —
   * "I could not tell" spelled as "no", in the harness written to refuse that.
   */
  /**
   * Issue #219 round 5. `ownsProcess` promised "a `t3 serve` for OUR data directory" and
   * performed `cmd.includes(runtimeDir)`. A substring of a path is not that: `tail -f
   * <runtimeDir>/server.log` satisfies it, and so does an editor with the path in its
   * argv — and that process then takes the group SIGTERM.
   *
   * Round 3 established that liveness is not ownership. The fix chosen was a substring,
   * which is not ownership either, and the docblock asserted the stronger claim. Same
   * shape as the close-handler comment last round, in the one function whose entire job
   * is deciding what to kill.
   */
  it('refuses a live process whose argv merely mentions the runtime directory', () => {
    const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
    const runtimeDir = mkdtempSync(join(tmpdir(), 't3-argv-'));
    const logPath = join(runtimeDir, 'server.log');
    writeFileSync(logPath, '');
    // A real process holding the runtime path in its command line — the exact shape a
    // human tailing the harness log produces.
    const bystander = spawn('tail', ['-f', logPath], { stdio: 'ignore', detached: true });
    try {
      expect(bystander.pid).toBeDefined();
      writeFileSync(join(runtimeDir, 'server.pid'), String(bystander.pid));

      const stopped = spawnSync(process.execPath, [harness, 'stop'], {
        encoding: 'utf8',
        env: { ...process.env, T3_HARNESS_DIR: runtimeDir, T3_HARNESS_PORT: '3896' },
      });

      expect(stopped.stderr).toContain(`REFUSING to signal pid ${bystander.pid}`);
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    } finally {
      try { process.kill(bystander.pid!, 'SIGKILL'); } catch { /* already gone */ }
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('the ownership check requires a `serve` bound to our data dir, both as real arguments', () => {
    // The two shapes the harness actually creates, from `ps -o command=`:
    //   npm exec t3@0.0.36 serve --host … --base-dir <dataDir> <checkout>
    //   node …/node_modules/.bin/t3 serve --host … --base-dir <dataDir> <checkout>
    // Both must be claimed, or `stop` stops recognising its own server — a refusal that
    // leaves a live server behind is its own failure.
    const src = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    expect(src).toContain("args.includes('serve')");
    expect(src).toContain("arg === '--base-dir' && args[i + 1] === dataDir");
    // Whole arguments, not a path found anywhere in the line. The behavioural proof is
    // the bystander test above; this pins the two halves so neither can be dropped
    // without the other being noticed.
    expect(src).toContain("const args = cmd.split(");
  });

  it('treats an lsof that cannot answer as unknown, not as a free port', () => {
    const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
    const emptyPath = mkdtempSync(join(tmpdir(), 't3-nolsof-'));
    const runtimeDir = mkdtempSync(join(tmpdir(), 't3-nolsof-rt-'));
    try {
      // A PATH with node and the harness's other helpers, but no `lsof`.
      for (const tool of ['node', 'ps', 'sleep', 'git']) {
        const found = spawnSync('command', ['-v', tool], { encoding: 'utf8', shell: true }).stdout.trim();
        if (found) symlinkSync(found, join(emptyPath, tool));
      }
      const refused = spawnSync(process.execPath, [harness, 'restart'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: emptyPath, T3_HARNESS_DIR: runtimeDir, T3_HARNESS_PORT: '3899' },
      });
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain('PORT_STATE_UNKNOWN: could not check:');
      // And not the answer it would have given before, which was a confident negative.
      expect(refused.stderr).not.toContain('NOT_RUNNING');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('requires a second opt-in before the unit suite can dispatch a live provider turn', () => {
    // Every live file, not one of them. The gate is only a gate if a new live
    // test cannot be added without it, and #219 added a second.
    for (const file of ['spec-146-phase-9-live-harness.test.ts', 'spec-146-phase-9-live-architect-thread.test.ts']) {
      const src = readFileSync(
        join(repoRoot, 'packages', 'codev', 'src', 'agent-farm', '__tests__', file),
        'utf8',
      );
      expect(src, file).toContain("process.env.T3_LIVE === '1'");
      expect(src, file).toContain('status.ok && runtime.ok && liveOptIn');
    }
  });
});

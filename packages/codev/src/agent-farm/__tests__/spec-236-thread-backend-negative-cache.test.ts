/**
 * Spec 236 — what Tower's 5s sweep costs a workspace that uses no thread backend.
 *
 * ## The defect this pins
 *
 * `requestThreadBackend` answers `ready`, `connecting` and `cooling-down` from
 * memory. `not-configured` and `misconfigured` needed the config, and those are
 * the verdicts of every workspace that never opted in — so the sweep ran a full
 * five-layer `loadConfig` per unconfigured workspace per pass, on Tower's event
 * loop, twelve times a minute each. #221 spent three rounds moving a network call
 * and then a sync syscall off that loop; four reads and four deep merges are not
 * a smaller version of the same thing.
 *
 * ## What is measured, and why it is measured this way
 *
 * The reads themselves, counted at `fs.readFileSync`. Asserting "the cache map has
 * an entry" would pass with the read still happening beside it — the saving IS the
 * absent read, so that is the observable.
 *
 * The second test is the one that decides whether the cache is safe: an operator
 * who writes their t3 config must not have to wait out a timer. There is no timer;
 * the signature changes and the next pass reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * COUNTED AT THE MODULE BOUNDARY, because `readFileSync` is an ESM export and
 * cannot be spied on in place. Everything else passes through to the real fs —
 * this measures reads, it does not simulate a filesystem.
 */
const readsUnder = { prefix: '', count: 0 };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: never, ...rest: never[]) => {
      if (readsUnder.prefix && typeof path === 'string' && path.startsWith(readsUnder.prefix)) {
        readsUnder.count += 1;
      }
      return (actual.readFileSync as never as (...a: never[]) => unknown)(path, ...rest);
    },
  };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const { clearThreadBackendFailures, requestThreadBackend } = await import('../thread-backend.js');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  readsUnder.prefix = '';
  clearThreadBackendFailures();
});

beforeEach(() => { clearThreadBackendFailures(); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'codev-236-negcache-'));
  roots.push(root);
  mkdirSync(join(root, '.codev'), { recursive: true });
  writeFileSync(join(root, '.codev', 'config.json'), JSON.stringify({ shell: {} }));
  return root;
}

/** Start counting reads of THIS workspace's files, ignoring the rest of the process. */
function countingReads(root: string) {
  readsUnder.prefix = root;
  readsUnder.count = 0;
  return { get reads() { return readsUnder.count; } };
}

describe('an unconfigured workspace on the sweep', () => {
  it('reads its config once, not once per pass', () => {
    const root = workspace();
    // The first call establishes the verdict and is expected to read.
    expect(requestThreadBackend(root).kind).toBe('not-configured');
    const counter = countingReads(root);

    // Twelve more passes: one minute of Tower's 5s sweep for this one workspace.
    for (let pass = 0; pass < 12; pass += 1) {
      expect(requestThreadBackend(root).kind).toBe('not-configured');
    }

    // Not "fewer than before" — NONE. Nothing it depends on changed, so there is
    // no read that could return anything different.
    expect(counter.reads).toBe(0);
  });

  it('notices a config written between two passes, with no timer to wait out', () => {
    const root = workspace();
    expect(requestThreadBackend(root).kind).toBe('not-configured');

    // The operator configures threads. The next sweep is the one that must see it.
    writeFileSync(join(root, '.codev', 'config.local.json'), JSON.stringify({
      threads: { serverUrl: 'ws://127.0.0.1:1/', bootstrapToken: 'token' },
    }));

    // `connecting`, not `not-configured`: the read happened and found a server.
    expect(requestThreadBackend(root).kind).toBe('connecting');
  });

  it('notices a config that becomes half-written, rather than holding the old verdict', () => {
    const root = workspace();
    const local = join(root, '.codev', 'config.local.json');
    expect(requestThreadBackend(root).kind).toBe('not-configured');

    writeFileSync(local, JSON.stringify({ threads: { serverUrl: 'ws://127.0.0.1:1/' } }));
    // Half-configured is its OWN verdict. Caching had better not spell it as the
    // `not-configured` that was true a moment ago — that is a typo the operator
    // never gets told about.
    const verdict = requestThreadBackend(root);
    expect(verdict.kind).toBe('misconfigured');

    // And the misconfigured verdict is itself cached, since it is the one an
    // unfixed workspace will report on every pass until someone fixes it.
    const counter = countingReads(root);
    expect(requestThreadBackend(root).kind).toBe('misconfigured');
    expect(counter.reads).toBe(0);
  });
});

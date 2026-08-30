/**
 * Issue #219 round 10 — `installThreadSpawnFactory`'s dormancy in Tower, pinned.
 *
 * `ensureThreadBackendReady` installs a PROCESS-GLOBAL spawn factory, and Tower now calls
 * that function for every workspace it delivers to. That is the bug the per-workspace
 * engine map fixed, one door down: a module-level singleton written from a
 * multi-workspace process.
 *
 * It is unreachable today for exactly one reason — **`chooseSpawnPath` has no consumer
 * inside Tower**. `afx spawn` is the only thing that reads it, and that is one workspace
 * per process. The factory also closes over the workspace it was installed for, so even
 * if it were read it would dispatch to the right engine; what is global is the
 * *selection*.
 *
 * That is a fact with a shelf life, and a comment saying so will not fail on the day it
 * stops being true. This does. The correct fix is #227's — drop the install from
 * `ensureThreadBackendReady`, because that function cannot know which process it is in —
 * and until that lands, this test is what notices a Tower-side consumer appearing.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const agentFarm = resolve(import.meta.dirname, '..');

/** Every production `.ts` under a directory, tests and type-only files excluded. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourcesUnder(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Files that read the spawn-path decision, as opposed to describing it in a comment. */
function callersOf(symbol: string, files: string[]): string[] {
  const call = new RegExp(`(^|[^\\w.])${symbol}\\s*\\(`);
  return files
    .filter((file) => {
      const src = readFileSync(file, 'utf8');
      return src
        .split('\n')
        // Comment lines mention it a lot — including the ones explaining this very
        // property — and a mention is not a consumer.
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .some((line) => call.test(line));
    })
    .map((file) => file.slice(agentFarm.length + 1));
}

describe('the process-global spawn factory stays dormant in Tower', () => {
  const sources = sourcesUnder(agentFarm);

  it('chooseSpawnPath has exactly one production consumer, and it is the CLI spawn path', () => {
    // `db/thread-identity.ts` defines it; a definition is not a consumption.
    const consumers = callersOf('chooseSpawnPath', sources)
      .filter((file) => file !== join('db', 'thread-identity.ts'));

    expect(consumers).toEqual([join('commands', 'spawn.ts')]);
  });

  it('nothing under servers/ reads the spawn-path decision', () => {
    // The specific shape that would make the global dangerous: Tower's own code asking
    // which path to spawn on, in a process serving every workspace at once.
    const serverSources = sources.filter((file) => file.includes(`${join('agent-farm', 'servers')}`));
    expect(serverSources.length).toBeGreaterThan(0); // the scan found the directory
    expect(callersOf('chooseSpawnPath', serverSources)).toEqual([]);
    expect(callersOf('allocateSpawnThread', serverSources)).toEqual([]);
  });

  it('the install still happens, so this is dormancy rather than absence', () => {
    // If the install were simply gone, the two assertions above would pass for the wrong
    // reason and #227 would look done.
    const backend = readFileSync(join(agentFarm, 'thread-backend.ts'), 'utf8');
    expect(backend).toContain('installThreadSpawnFactory(key)');
  });
});

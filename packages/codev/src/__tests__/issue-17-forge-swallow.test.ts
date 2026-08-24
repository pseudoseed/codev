/**
 * Issue #17 — a broken forge concept rendered as an empty panel.
 *
 * `executeForgeCommand` returns `null` for a timeout, a non-zero exit and an
 * unparseable body alike, and every caller reads `null` as "no results".
 * Nothing reached stderr; `logDebug` sits behind `CODEV_DEBUG`, which nobody
 * sets.
 *
 * Measured live on 2026-08-21: `recently-merged` on gitea against `~/dev/entriq`
 * paged `pulls?state=closed` at 48.1s for page one against a 30s timeout, so it
 * timed out every time. `getOverview` calls it on a 30s TTL and is hit by both
 * the dashboard `/api/overview` poll and by every `afx status` while Tower runs.
 * It had been failing on every one of those calls, invisibly, for as long as
 * that repo had that many PRs.
 *
 * Nobody noticed because empty looks like a valid answer. An empty panel that
 * means "broken" is worse than an error, because it is believable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  executeForgeCommand,
  executeForgeCommandSync,
  executeForgeCommandDetailed,
  classifyForgeError,
  _resetForgeFailureWarnings,
} from '../lib/forge.js';

let stderr: string[];

beforeEach(() => {
  _resetForgeFailureWarnings();
  delete process.env.CODEV_FORGE_QUIET;
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetForgeFailureWarnings();
  delete process.env.CODEV_FORGE_QUIET;
});

const said = (): string => stderr.join('');

/** Wire the concept to an arbitrary shell command, bypassing provider presets. */
const asCommand = (command: string | null) => ({
  forgeConfig: { 'recently-merged': command },
});

describe('#17: a timeout says so instead of returning quietly', () => {
  it('warns when the command exceeds its timeout', async () => {
    const result = await executeForgeCommand('recently-merged', {}, {
      ...asCommand('sleep 5'),
      timeoutMs: 150,
    });

    expect(result).toBeNull();
    expect(said()).toContain("'recently-merged'");
    expect(said()).toContain('timed out');
  }, 20_000);

  it('says explicitly that the null is not an empty result', async () => {
    // The whole defect in one sentence. A caller renders an empty panel from
    // this null; the operator needs to know the panel is a lie.
    await executeForgeCommand('recently-merged', {}, { ...asCommand('sleep 5'), timeoutMs: 150 });

    expect(said()).toContain('NO RESULTS, which is not the same as none');
  }, 20_000);

  it('names the limit it exceeded, so the remedy is obvious', async () => {
    await executeForgeCommand('recently-merged', {}, { ...asCommand('sleep 5'), timeoutMs: 150 });

    expect(said()).toMatch(/limit \d+(ms|s)\b/);
  }, 20_000);
});

describe('#17: a non-zero exit says so too', () => {
  it('warns and names the exit code', async () => {
    const result = await executeForgeCommand('recently-merged', {}, {
      ...asCommand('exit 3'),
      timeoutMs: 5_000,
    });

    expect(result).toBeNull();
    expect(said()).toContain('exited 3');
  });

  it('carries the first line of stderr, which is usually the whole diagnosis', async () => {
    await executeForgeCommand('recently-merged', {}, {
      ...asCommand('echo "gh: not authenticated" >&2; exit 4'),
      timeoutMs: 5_000,
    });

    expect(said()).toContain('gh: not authenticated');
  });
});

describe('#17: a genuinely empty result stays silent', () => {
  // The distinction that has to hold. If empty warns too, the warning means
  // nothing and gets tuned out.
  it('says nothing when the command succeeds with an empty list', async () => {
    const result = await executeForgeCommand('recently-merged', {}, {
      ...asCommand('echo "[]"'),
      timeoutMs: 5_000,
    });

    expect(result).toEqual([]);
    expect(said()).toBe('');
  });

  it('says nothing when the command succeeds with results', async () => {
    const result = await executeForgeCommand('recently-merged', {}, {
      ...asCommand('echo \'[{"number":1}]\''),
      timeoutMs: 5_000,
    });

    expect(result).toEqual([{ number: 1 }]);
    expect(said()).toBe('');
  });

  it('says nothing for a concept that is explicitly disabled', async () => {
    // Not configured is not broken. Warning here would fire constantly on every
    // install that deliberately turns a concept off.
    const result = await executeForgeCommand('recently-merged', {}, asCommand(null));

    expect(result).toBeNull();
    expect(said()).toBe('');
  });
});

describe('#17: a poll loop reports a breakage once, not every tick', () => {
  it('warns on the first failure and stays quiet after', async () => {
    // getOverview runs on a 30s TTL against both the dashboard poll and every
    // `afx status`. A warning per tick would be its own kind of unreadable.
    for (let i = 0; i < 3; i++) {
      await executeForgeCommand('recently-merged', {}, { ...asCommand('exit 3'), timeoutMs: 5_000 });
    }

    expect(said().match(/\[forge\]/g) ?? []).toHaveLength(1);
  });

  it('says that it will not repeat, so silence afterwards is not read as recovery', async () => {
    await executeForgeCommand('recently-merged', {}, { ...asCommand('exit 3'), timeoutMs: 5_000 });

    expect(said()).toContain('are silent');
  });

  it('warns again when the SAME concept starts failing a different way', async () => {
    // A concept that was erroring and starts timing out is new information.
    await executeForgeCommand('recently-merged', {}, { ...asCommand('exit 3'), timeoutMs: 5_000 });
    await executeForgeCommand('recently-merged', {}, { ...asCommand('sleep 5'), timeoutMs: 150 });

    expect(said().match(/\[forge\]/g) ?? []).toHaveLength(2);
  }, 20_000);

  it('CODEV_FORGE_QUIET silences it entirely', async () => {
    process.env.CODEV_FORGE_QUIET = '1';

    await executeForgeCommand('recently-merged', {}, { ...asCommand('exit 3'), timeoutMs: 5_000 });

    expect(said()).toBe('');
  });
});

describe('#17: the sync variant swallows identically, so it warns identically', () => {
  it('warns on a non-zero exit', () => {
    const result = executeForgeCommandSync('recently-merged', {}, {
      ...asCommand('exit 3'),
      timeoutMs: 5_000,
    });

    expect(result).toBeNull();
    expect(said()).toContain('(sync)');
    expect(said()).toContain('exited 3');
  });
});

describe('#17: the detailed variant hands the failure over instead of warning', () => {
  it('stays silent — its caller is the one that reports', async () => {
    const r = await executeForgeCommandDetailed('recently-merged', {}, {
      ...asCommand('exit 3'),
      timeoutMs: 5_000,
    });

    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(said()).toBe('');
  });

  it('classifies a timeout the same way the warning does', async () => {
    const r = await executeForgeCommandDetailed('recently-merged', {}, {
      ...asCommand('sleep 5'),
      timeoutMs: 150,
    });

    expect(r.timedOut).toBe(true);
  }, 20_000);
});

describe('#17: classifyForgeError', () => {
  it('reads killed + signal as a timeout, which is how Node reports its own', () => {
    expect(classifyForgeError({ killed: true, signal: 'SIGTERM', code: null }).timedOut).toBe(true);
  });

  it('does not read a bare non-zero exit as a timeout', () => {
    // A killed process can still exit with a status, and a script that times
    // out INTERNALLY exits non-zero with its own envelope on stdout.
    const c = classifyForgeError({ code: 124, killed: false });

    expect(c.timedOut).toBe(false);
    expect(c.exitCode).toBe(124);
  });

  it('reports a non-numeric code as no exit code rather than as zero', () => {
    expect(classifyForgeError({ code: 'ENOENT' }).exitCode).toBeNull();
  });
});

describe('#17: exec and execSync report the same facts in different fields', () => {
  // Measured directly against node 20. Reading only `code` lost every sync exit
  // status and every sync timeout, which is how the sync variant stayed silent
  // about both while looking like it was handled.
  it('reads an async exit code from `code`', () => {
    expect(classifyForgeError({ code: 3 }).exitCode).toBe(3);
  });

  it('reads a sync exit code from `status`', () => {
    expect(classifyForgeError({ status: 3, signal: null }).exitCode).toBe(3);
  });

  it('reads an async timeout from killed + signal', () => {
    expect(classifyForgeError({ killed: true, signal: 'SIGTERM' }).timedOut).toBe(true);
  });

  it('reads a sync timeout from ETIMEDOUT', () => {
    expect(classifyForgeError({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }).timedOut).toBe(true);
  });

  it('does not read a sync non-zero exit as a timeout', () => {
    expect(classifyForgeError({ status: 3, signal: null }).timedOut).toBe(false);
  });
});

describe('#17: the duration in the warning has to describe something', () => {
  it('does not round a sub-second bound down to "0s"', async () => {
    // "timed out after 0s (limit 0s)" is not a report, it is noise wearing the
    // shape of one.
    await executeForgeCommand('recently-merged', {}, { ...asCommand('sleep 5'), timeoutMs: 150 });

    expect(said()).toContain('limit 150ms');
    expect(said()).not.toContain('limit 0s');
  }, 20_000);

  it('uses seconds once the bound is a second or more', async () => {
    await executeForgeCommand('recently-merged', {}, { ...asCommand('sleep 30'), timeoutMs: 1_200 });

    expect(said()).toContain('limit 1s');
  }, 20_000);
});

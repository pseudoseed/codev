/**
 * Issue #241 — adoption after a Tower restart.
 *
 * `ThreadEngine.attach` has one other production caller, the mailbox delivery path,
 * so without this sweeper a thread acquires a subscription only when somebody sends
 * it a message. These tests are about the three ways a sweep can lie: by treating a
 * failed read as an empty one, by letting one failure skip everything after it, and
 * by adopting into a workspace whose backend is not up.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createThreadAdoptionSweeper,
  type AdoptableThread,
} from '../thread-subscriptions.js';

function thread(id: string): AdoptableThread {
  return { threadId: id, worktreePath: `/w/${id}`, branch: `b/${id}`, builderId: id };
}

describe('createThreadAdoptionSweeper (issue #241)', () => {
  it('adopts every thread in every ready workspace', async () => {
    const attached: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/a', '/w/b'],
      threads: (root) => (root === '/w/a' ? [thread('t1'), thread('t2')] : [thread('t3')]),
      isReady: () => true,
      engineFor: () => ({ async attach(input) { attached.push(input.threadId); } }),
      log: () => {},
    });

    await sweeper.sweep();
    expect(attached).toEqual(['t1', 't2', 't3']);
  });

  /**
   * NULL IS NOT AN EMPTY LIST. A locked `global.db` says nothing about how many
   * threads a workspace has, and adopting none of them because the read failed would
   * leave every one unwatched while reporting nothing wrong.
   */
  it('a failed thread read adopts nothing and is not read as "no threads"', async () => {
    const attached: string[] = [];
    const warnings: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/a', '/w/b'],
      threads: (root) => (root === '/w/a' ? null : [thread('t3')]),
      isReady: () => true,
      engineFor: () => ({ async attach(input) { attached.push(input.threadId); } }),
      log: (level, message) => { if (level !== 'INFO') warnings.push(message); },
    });

    await sweeper.sweep();
    // `/w/a` contributed nothing, and `/w/b` was not skipped because of it.
    expect(attached).toEqual(['t3']);
  });

  it('a failed workspace read runs no pass at all rather than an empty one', async () => {
    const attached: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => null,
      threads: () => [thread('t1')],
      isReady: () => true,
      engineFor: () => ({ async attach(input) { attached.push(input.threadId); } }),
      log: () => {},
    });

    await sweeper.sweep();
    expect(attached).toEqual([]);
  });

  it('skips a workspace whose backend is not ready, without throwing', async () => {
    const attached: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/off', '/w/on'],
      threads: () => [thread('t1')],
      isReady: (root) => root === '/w/on',
      engineFor: () => ({ async attach(input) { attached.push(`${input.threadId}`); } }),
      log: () => {},
    });

    await sweeper.sweep();
    expect(attached).toEqual(['t1']);
  });

  it('skips a workspace with no engine registered, without throwing', async () => {
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/a'],
      threads: () => [thread('t1')],
      isReady: () => true,
      engineFor: () => undefined,
      log: () => {},
    });
    await expect(sweeper.sweep()).resolves.toBeUndefined();
  });

  /**
   * PER THREAD. A throw that escaped would skip every thread after it in the same
   * workspace, and they would be silently unwatched — the exact failure shape this
   * sweeper exists to remove, reintroduced by its own error handling.
   */
  it('one thread failing to adopt does not skip the ones after it', async () => {
    const attached: string[] = [];
    const warnings: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/a'],
      threads: () => [thread('t1'), thread('boom'), thread('t3')],
      isReady: () => true,
      engineFor: () => ({
        async attach(input) {
          if (input.threadId === 'boom') throw new Error('the server refused');
          attached.push(input.threadId);
        },
      }),
      log: (level, message) => { if (level === 'WARN') warnings.push(message); },
    });

    await sweeper.sweep();
    expect(attached).toEqual(['t1', 't3']);
    expect(warnings.join('\n')).toContain('boom');
    // And it says what it is NOT, so the line is not read as "the thread is gone".
    expect(warnings.join('\n')).toContain('not evidence that the thread is gone');
  });

  it('one workspace throwing does not skip the ones after it', async () => {
    const attached: string[] = [];
    const errors: string[] = [];
    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/bad', '/w/good'],
      threads: (root) => {
        if (root === '/w/bad') throw new Error('database is locked');
        return [thread('t9')];
      },
      isReady: () => true,
      engineFor: () => ({ async attach(input) { attached.push(input.threadId); } }),
      log: (level, message) => { if (level === 'ERROR') errors.push(message); },
    });

    await sweeper.sweep();
    expect(attached).toEqual(['t9']);
    expect(errors.join('\n')).toContain('/w/bad');
  });

  /**
   * `attach` awaits a subscription's attach budget, so a slow server can make a pass
   * outlast its interval. Overlapping passes would stack `attach` calls on the same
   * threads.
   */
  it('does not start a second pass while one is running', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    const sweeper = createThreadAdoptionSweeper({
      workspaces: () => ['/w/a'],
      threads: () => [thread('t1')],
      isReady: () => true,
      engineFor: () => ({
        async attach() {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await gate;
          inFlight -= 1;
        },
      }),
      log: () => {},
    });

    const first = sweeper.sweep();
    const second = sweeper.sweep();
    release();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
  });

  it('start and stop own exactly one interval', async () => {
    vi.useFakeTimers();
    try {
      const attached: string[] = [];
      const sweeper = createThreadAdoptionSweeper({
        workspaces: () => ['/w/a'],
        threads: () => [thread('t1')],
        isReady: () => true,
        engineFor: () => ({ async attach(input) { attached.push(input.threadId); } }),
        log: () => {},
        intervalMs: 100,
      });
      sweeper.start();
      // A second start must not add a second interval.
      sweeper.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(attached).toEqual(['t1']);

      sweeper.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attached).toEqual(['t1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

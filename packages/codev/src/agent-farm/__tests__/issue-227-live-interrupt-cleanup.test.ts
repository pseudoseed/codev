/**
 * Issue #227 item 2, against a real t3code server — `afx interrupt` and `afx cleanup`.
 *
 * ## Why this file exists and the other one is not enough
 *
 * `issue-227-thread-seams.test.ts` proves adoption works against an in-memory engine and
 * that both commands are spelled to reach it. Neither of those is the claim. The claim is
 * that a **fresh `afx` process**, which has registered no engine, can reach a thread on a
 * real server and act on it — and #222 is the standing record of what happens when this
 * program accepts a test that shares the code's premise in place of one that runs it:
 * *"Spec 146 phases ship code with no production caller, and every test passes anyway."*
 *
 * So this test spawns the real CLI, in real child processes, against the pinned harness.
 *
 * ## Three things it does deliberately
 *
 * **It runs the CLI from SOURCE via `tsx`, not from `dist`.** `bin/afx.js` imports `dist/`,
 * which is a build artifact that can be older than the change under test — and a live test
 * that green-lights stale code is the failure mode this file was written to close, not one
 * to reintroduce at the last step.
 *
 * **It costs no provider turn.** `engine.create` without a `prompt` makes a thread and
 * starts nothing, and neither `interrupt` nor `cleanup` needs a turn to settle. That is
 * also why this does not wait on #241.
 *
 * **It restarts the server between commands, and that is not incidental.** A pairing grant
 * is one-time (`PairingGrantStore.consume` deletes it at `remainingUses <= 1`) and the
 * harness prints one token per server lifetime, while every `afx` process exchanges the
 * token again. `restart` keeps the data directory and issues a new token, so each process
 * gets a credential it can actually spend. The side effect is worth stating: each command
 * therefore acts on a thread that outlived the server it was created on, which is the
 * strongest available form of "this process did not create this thread".
 *
 * ## Running it
 *
 * ```bash
 * pnpm --filter @cluesmith/codev-types build
 * pnpm --filter @cluesmith/t3-client build
 * T3_NODE=/opt/homebrew/bin/node T3_LIVE=1 \
 *   pnpm --filter @cluesmith/codev exec vitest run \
 *   src/agent-farm/__tests__/issue-227-live-interrupt-cleanup.test.ts
 * ```
 *
 * It owns its own port and runtime directory so it cannot collide with the other live
 * tests, which start and stop servers of their own.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createProject } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from '../porch-thread-engine.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harnessScript = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
// `cli.ts` exports `runAgentFarm` and calls nothing, so running it directly exits 0 in
// silence — a pass shaped like a success. `helpers/air-227-afx-from-source.ts` is
// `bin/afx.js` with its dist import pointed at the source instead.
const cliEntry = join(
  repoRoot, 'packages', 'codev', 'src', 'agent-farm', '__tests__', 'helpers',
  'air-227-afx-from-source.ts',
);
const tsx = join(repoRoot, 'packages', 'codev', 'node_modules', '.bin', 'tsx');

/** Its own port and data directory: the other live tests start servers too. */
const harnessEnv = {
  ...process.env,
  T3_HARNESS_PORT: process.env.T3_HARNESS_PORT_227 ?? '3803',
  T3_HARNESS_DIR: join(repoRoot, 'tools', 't3-server', '.runtime-227'),
};

function harness(command: string, timeout = 90_000): string {
  return execFileSync(process.execPath, [harnessScript, command], {
    encoding: 'utf8',
    timeout,
    env: harnessEnv,
  });
}

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harnessScript)) return { ok: false, reason: `could not check: missing ${harnessScript}` };
  try {
    harness('verify', 15_000);
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const code = (err as { status?: number }).status;
    // Three answers, not two. "I could not check" must not exit like "checked and fine".
    if (code === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (code === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: `could not check: verify failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

function runtimeStatus(): { ok: boolean; reason: string } {
  try {
    harness('runtime', 15_000);
    return { ok: true, reason: 'interpreter resolved' };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    const signal = stderr.split('\n').find((line) => /[A-Z_]+: could not check:/.test(line));
    return {
      ok: false,
      reason: signal?.replace(/^\[t3-server\] /, '')
        ?? 'RUNTIME_UNAVAILABLE: could not check: runtime command failed without a named signal',
    };
  }
}

/**
 * A fresh pairing token for the next process to spend.
 *
 * `ready` polls, because a server that has bound its port has not necessarily printed its
 * token yet, and reading too early yields "answering but printed no pairing token" — a
 * truthful sentence about the wrong thing.
 */
async function readyToken(): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 120_000;
  let out = '';
  while (Date.now() < deadline) {
    try {
      out = harness('ready', 20_000);
      if (out.includes('{')) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!out.includes('{')) throw new Error('COULD_NOT_TELL: the live server printed no ready JSON');
  return JSON.parse(out.slice(out.indexOf('{'))) as { port: number; token: string };
}

/** See the note at the interrupt call: vitest hides `console.*` from a passing test. */
function report(line: string): void {
  process.stdout.write(`${line.replace(/\n+$/, '')}\n`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A workspace `getConfig()` will resolve to, holding a real git worktree.
 *
 * `codev/` is what `findWorkspaceRoot` looks for; the worktree has to be a real one because
 * cleanup ends in a server-side `git worktree remove`. Its branch is left at `main`'s commit
 * so it is genuinely merged — `--force` would skip the check this way proves.
 */
function makeWorkspace(): { ws: string; worktree: string; farmDir: string } {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'air-227-live-')));
  mkdirSync(join(ws, 'codev'), { recursive: true });
  mkdirSync(join(ws, '.codev'), { recursive: true });
  git(ws, 'init', '-b', 'main');
  git(ws, 'config', 'user.email', 'air-227@example.invalid');
  git(ws, 'config', 'user.name', 'air-227');
  writeFileSync(join(ws, 'README.md'), '# air-227 live fixture\n');
  git(ws, 'add', 'README.md');
  git(ws, 'commit', '-m', 'base');
  const worktree = join(ws, '.builders', 'live-227');
  git(ws, 'worktree', 'add', '-b', 'builder/live-227', worktree);
  const farmDir = join(ws, '.agent-farm-home');
  mkdirSync(farmDir, { recursive: true });
  return { ws, worktree, farmDir };
}

/**
 * Point the workspace at the server with a token the NEXT process can spend.
 *
 * Rewritten before every child, because the previous one consumed the previous token. The
 * production requirement is a credential that survives repeated exchange; this test meets
 * it by supplying a fresh one per process rather than by pretending one does.
 */
function writeThreadsConfig(ws: string, port: number, token: string): void {
  writeFileSync(
    join(ws, '.codev', 'config.json'),
    `${JSON.stringify({ threads: { serverUrl: `http://127.0.0.1:${port}`, bootstrapToken: token } }, null, 2)}\n`,
  );
}

/**
 * The builder row, written straight into a throwaway `global.db`.
 *
 * Direct SQL rather than `upsertBuilder`, because this process must not bind the state
 * layer's module-level database singleton to the throwaway directory — the child processes
 * are what have to read it, and they get there through `CODEV_AGENT_FARM_DIR`. Built from
 * the shipped `GLOBAL_SCHEMA`, so a column that exists only here cannot make it pass.
 */
function seedBuilderRow(farmDir: string, row: {
  workspacePath: string;
  id: string;
  worktree: string;
  branch: string;
  threadId: string;
  harness: string;
  model: string;
}): void {
  const db = new Database(join(farmDir, 'global.db'));
  db.pragma('journal_mode = WAL');
  db.exec(GLOBAL_SCHEMA);
  // Every migration is already reflected by GLOBAL_SCHEMA, so record them: a child that
  // re-ran them against this shape would be doing upgrade work on a fresh install.
  for (let v = 1; v <= 22; v += 1) {
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
  }
  db.prepare(`
    INSERT INTO builders (workspace_path, id, name, worktree, branch, type, status, thread_id, harness, model)
    VALUES (@workspacePath, @id, @id, @worktree, @branch, 'spec', 'implementing', @threadId, @harness, @model)
  `).run(row);
  db.close();
}

function builderRows(farmDir: string): Array<{ id: string }> {
  const db = new Database(join(farmDir, 'global.db'), { readonly: true });
  try {
    return db.prepare('SELECT id FROM builders').all() as Array<{ id: string }>;
  } finally {
    db.close();
  }
}

/**
 * One fresh `afx` process — no engine registered in it, which is the whole point.
 *
 * THE SCRUBBED VARIABLES ARE NOT HOUSEKEEPING. `detectWorkspaceRoot` consults
 * `CODEV_THREAD_ID`, then `CODEV_BUILDER_ID` + `CODEV_WORKTREE_ROOT`, BEFORE it looks at
 * the working directory — deliberately, because a builder's identity belongs to its
 * session rather than to wherever it has `cd`-ed. This test is itself run by a builder, so
 * inheriting the parent environment pointed the child at the real workspace: it resolved
 * the developer's own repository instead of the fixture, and looked for `live-227` there.
 * A live test that acts on the operator's workspace is worse than one that does not run.
 */
function afx(args: string[], ws: string, farmDir: string): { status: number; output: string } {
  const env = { ...process.env, CODEV_AGENT_FARM_DIR: farmDir };
  delete env.CODEV_THREAD_ID;
  delete env.CODEV_BUILDER_ID;
  delete env.CODEV_WORKTREE_ROOT;
  // And `NODE_ENV`, which vitest sets to `test` — under which `getGlobalDbPath` resolves
  // `test.db` instead of `global.db`. The child then opened an empty database beside the
  // seeded one, found no builder, and fell through to the PTY path: a command that reports
  // a Tower error for a thread-backed builder, which is not the thing under test failing.
  // Isolation here comes from `CODEV_AGENT_FARM_DIR` pointing at a throwaway directory, so
  // the child can use the production filename inside it.
  delete env.NODE_ENV;
  try {
    const out = execFileSync(tsx, [cliEntry, ...args], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 120_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: out };
  } catch (err) {
    // `status` is undefined when the child never started (ENOENT), and `stdout`/`stderr`
    // are null — so a spawn failure and a silent non-zero exit produced identical evidence
    // until the spawn error itself was carried through. They are different faults.
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return { status: e.status ?? -1, output: output || `spawn failed: ${e.message ?? 'unknown'}` };
  }
}

describe('issue #227 item 2 — afx interrupt and afx cleanup against a live t3code server', () => {
  const status = harnessStatus();
  const runtime = runtimeStatus();
  const liveOptIn = process.env.T3_LIVE === '1';
  const canRunLive = status.ok && runtime.ok && liveOptIn;

  it.skipIf(!canRunLive)(
    '[live: requires T3_LIVE=1 + T3_NODE] a fresh process interrupts and cleans up a thread it did not create',
    async () => {
      try {
        harness('stop', 30_000);
      } catch {
        /* nothing was running */
      }
      harness('start');
      const first = await readyToken();

      const { ws, worktree, farmDir } = makeWorkspace();
      const journalPath = join(ws, '.codev', 'commands.jsonl');
      let threadId = '';
      try {
        // --- Create the thread, in THIS process, on the server. -------------------
        const { T3Client } = await import('../../../../t3-client/dist/client.js');
        const auth = await import('../../../../t3-client/dist/auth.js');
        const base = `http://127.0.0.1:${first.port}`;
        const access = await auth.exchangeBootstrapToken(base, first.token, {
          clientLabel: 'codev-air-227-live',
        });
        const ticket = await auth.issueWebSocketTicket(base, access.access_token);
        const socket = new WebSocket(auth.webSocketUrl(base, ticket.ticket));
        await new Promise<void>((res, rej) => {
          socket.addEventListener('open', () => res(), { once: true });
          socket.addEventListener('error', () => rej(new Error('socket error')), { once: true });
        });
        const client = new T3Client({
          send: (d: string) => socket.send(d),
          close: () => socket.close(),
          addEventListener: (t: string, l: (ev: unknown) => void) => socket.addEventListener(t, l as never),
          get readyState() {
            return socket.readyState;
          },
        });
        const dispatcher = { call: (method: string, payload: unknown) => client.call(method, payload) };
        const journal = new DispatchJournal(journalPath);
        const projectId = await createProject(dispatcher, journal, {
          title: 'air-227-live',
          workspaceRoot: ws,
        });
        const engine = createPorchThreadEngine({
          dispatcher,
          journal,
          tracker: new TurnTracker(),
          projectId,
          workspaceRoot: ws,
          defaultHarness: 'codex',
          defaultModel: 'gpt-5.6-luna',
        });
        // No `prompt`: a thread, and no turn. Item 2's commands need neither.
        threadId = await engine.create({
          builderId: 'live-227',
          worktreePath: worktree,
          branch: 'builder/live-227',
        });
        expect(threadId.length).toBeGreaterThan(0);
        report(`created thread ${threadId} on 127.0.0.1:${first.port} for worktree ${worktree}`);
        socket.close();

        // The pair goes ON THE ROW, and the workspace config below names neither — which
        // is the point, not an omission. `DriverThread.attach` refuses without a model
        // ("t3code's thread.create lists modelSelection among its required fields, so
        // there is no 'let the server choose' here"), so the only thing that can make this
        // attach succeed is the (harness, model) `adoptThreadInThisProcess` reads off the
        // builder row. The first live run failed here for exactly that reason, which is
        // evidence no source guard could have produced.
        seedBuilderRow(farmDir, {
          workspacePath: ws,
          id: 'live-227',
          worktree,
          branch: 'builder/live-227',
          threadId,
          harness: 'codex',
          model: 'gpt-5.6-luna',
        });

        // --- afx interrupt, in a process that has registered nothing. --------------
        harness('restart');
        const second = await readyToken();
        writeThreadsConfig(ws, second.port, second.token);

        const interrupted = afx(['interrupt', 'live-227'], ws, farmDir);
        // Printed, because the evidence a live test produces is what it SAW, and an
        // assertion that passes consumes it silently. A reader of the run output should
        // not have to take the green tick's word for it.
        //
        // `process.stdout.write`, not `console.log`: vitest intercepts `console.*` and
        // reports it only for failing tests — so the run that most needs to show its
        // transcript, the passing one, is the run that would not.
        report(`$ afx interrupt live-227  -> exit ${interrupted.status}\n${interrupted.output}`);
        // Before this change the same command exited 1 with "No thread engine is
        // registered in this process for <ws>" — accurate, and not working.
        expect(interrupted.output).not.toMatch(/No thread engine is registered/);
        expect(interrupted.output).toContain(`Interrupt sent to thread ${threadId}`);
        expect(interrupted.status).toBe(0);

        // --- afx cleanup, in another one. ------------------------------------------
        harness('restart');
        const third = await readyToken();
        writeThreadsConfig(ws, third.port, third.token);

        const cleaned = afx(['cleanup', '-p', 'live-227'], ws, farmDir);
        report(`$ afx cleanup -p live-227  -> exit ${cleaned.status}\n${cleaned.output}`);
        expect(cleaned.output).not.toMatch(/No thread engine is registered/);
        // `Unknown thread` is the OTHER failure this fixes: an engine that was registered
        // but never told about the thread reports it missing, which reads as "no such
        // thread". Attaching is what makes the difference.
        expect(cleaned.output).not.toMatch(/has not been attached/);
        expect(cleaned.output).toContain('Thread-backed builder live-227 cleaned up');
        expect(cleaned.status).toBe(0);

        // The server removed the worktree, and the row is gone. Both are side effects on
        // the world, not on the engine's memory of it.
        expect(existsSync(worktree)).toBe(false);
        expect(builderRows(farmDir).map((r) => r.id)).not.toContain('live-227');
      } finally {
        rmSync(ws, { recursive: true, force: true });
        try {
          harness('stop', 30_000);
        } catch {
          /* already down */
        }
      }
    },
    600_000,
  );

  it('records live readiness or the exact reason it could not check', () => {
    if (!status.ok) {
      expect(status.reason).toMatch(/^could not check:/);
      return;
    }
    if (!runtime.ok) {
      expect(runtime.reason).toMatch(/could not check:/);
      return;
    }
    expect(status.reason).toBe('verified');
    expect(runtime.reason).toBe('interpreter resolved');
    // A configured interpreter must not be enough on its own to make the default suite
    // start servers and spawn CLI processes.
    if (!liveOptIn) expect(process.env.T3_LIVE).not.toBe('1');
  });
});

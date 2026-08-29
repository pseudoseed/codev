/**
 * Run the Issue #197 safety assertions against PRODUCTION code with no vitest and no port
 * 13999 suite lock (Issue #197).
 *
 * QUESTION IT ANSWERS: does a live turn on a mismatched mirror ever receive a recovery
 * keystroke? Asserted on the BYTES the session writes, not on a classification — a verdict is
 * an opinion, a written byte is what reaches the agent.
 *
 * WHY IT EXISTS. The first fix for the review's blocking finding reordered the classifier so
 * the busy check ran first. Running this took ~1s and showed the fix did not work: an ESC was
 * still written to a live turn. That is what produced the real fix (`geometry-mismatch` earns
 * no recovery action at all) before CI could report the reorder as sufficient. Its value is
 * that it needs no lock, so it can be run while the suite is queued behind another builder.
 *
 *   pnpm exec tsx verify-no-keystroke.mts
 *
 * Exits non-zero on any failure.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SRC } from './_paths.mts';
const { PtySession } = await import(join(SRC, 'terminal/pty-session.js'));
const { classifyAgentScreen } = await import(join(SRC, 'agent-farm/servers/mailbox-wiring.js'));
const { OPENCODE_PROFILE } = await import(join(SRC, 'agent-farm/servers/gate-profiles.js'));
const { heldRecoveryAction, heldRecoveryKeystroke } =
  await import(join(SRC, 'agent-farm/servers/mailbox-hold-policy.js'));

const CAPTURE = { cols: 110, rows: 32 };   // geometry every opencode197-* fixture was taken at
const BORN = { cols: 80, rows: 24 };       // defaultSessionOptions() — what a session is born at

const writes: string[] = [];
function fakeClient(geom: { cols: number; rows: number } | null): any {
  const e = new EventEmitter() as any;
  Object.defineProperty(e, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(e, 'connected', { get: () => true });
  Object.defineProperty(e, 'ptyGeometry', { get: () => geom });
  e.write = (d: string) => { writes.push(d); return true; };
  e.resize = () => false;  // models the DROPPED app-side resize that creates the divergence
  return e;
}
const mkSession = () => new PtySession({
  id: 'v', command: 'opencode', args: [], cols: BORN.cols, rows: BORN.rows,
  cwd: '/tmp', env: {}, label: 'research-197', logDir: '/tmp', diskLogEnabled: false,
});
const seed = (n: string) => readFileSync(join(FIXTURES, n));

let fails = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)}`}`);
  if (!ok) fails++;
};

// The fix itself: an idle builder born at 80x24 delivers once the real geometry is adopted.
{
  const s = mkSession();
  s.attachShellper(fakeClient(CAPTURE), Buffer.alloc(0), 1, undefined, seed('opencode197-idle.clean.txt'));
  const v = await classifyAgentScreen(s, OPENCODE_PROFILE);
  check('idle DELIVERS after geometry adoption', v.clean === true && v.detail === 'empty', v);
}
// Without adoption it holds — and at 80x24 the frame-inference checks cannot even name why.
{
  const s = mkSession();
  s.attachShellper(fakeClient(null), Buffer.alloc(0), 1, undefined, seed('opencode197-idle.clean.txt'));
  const v = await classifyAgentScreen(s, OPENCODE_PROFILE);
  check('no adoption -> holds (no-composer-marker)', v.detail === 'no-composer-marker', v);
}
// THE ONE THAT MATTERS: a live turn on a mismatched mirror receives NOTHING.
{
  writes.length = 0;
  const s = mkSession();
  s.attachShellper(fakeClient(CAPTURE), Buffer.alloc(0), 1, undefined, seed('opencode197-midturn.busy.txt'));
  s.resize(BORN.cols, BORN.rows);   // mirror moves, PTY does not -> divergence
  const v = await classifyAgentScreen(s, OPENCODE_PROFILE);
  const action = heldRecoveryAction(v.detail);
  check('mid-turn mismatched -> no recovery action', action === null, { detail: v.detail, action });
  if (action) s.write(heldRecoveryKeystroke(action));
  check('NO BYTES written to a live turn', writes.length === 0, writes);
}
// Positive control: without it, the assertion above passes against a harness that cannot see
// a write at all — a green check proving nothing.
{
  writes.length = 0;
  const s = mkSession();
  s.attachShellper(fakeClient(CAPTURE), Buffer.alloc(0), 1);
  const a = heldRecoveryAction('user-text');
  if (a) s.write(heldRecoveryKeystroke(a));
  check('POSITIVE CONTROL: a real keystroke IS observed', writes.length === 1, writes);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

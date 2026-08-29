/**
 * Gate-mirror geometry adoption on attach (Issue #197).
 *
 * The bug these pin: `createSessionRaw` builds EVERY shellper-backed session at
 * `defaultSessionOptions()` — 80x24 — and nothing but a connected browser client ever
 * calls `resize()`. The shellper process outlives Tower and keeps its PTY at whatever size
 * a client last set it to. Measured on the live fleet via `GET /api/terminals`: real
 * sessions run at 60–84 rows. So after a Tower restart or a re-attach the gate mirror is 24
 * rows while the agent is still painting at 60+, and for an UNATTENDED builder nobody ever
 * sends the resize that would fix it.
 *
 * For a BOTTOM-ANCHORED composer (opencode) that is fatal rather than cosmetic: the box
 * occupies the frame's last rows, a short viewport clips it away entirely, `rulePattern`
 * matches nothing, and the render gate returns `no-composer-marker` for every message
 * forever — the Issue #197 field failure (holds of 3.5m, 8m and 12m to an opencode builder
 * while claude and codex in the same workspace delivered on the first attempt).
 *
 * The WELCOME frame has always carried the shellper's real geometry. It was simply
 * discarded. These tests pin that it is adopted, and — the one that matters — that adopting
 * it makes the gate return CLEAN on a real opencode idle capture, i.e. the mail DELIVERS.
 * A correctly-named hold would not have been a fix.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PtySession, type PtySessionConfig } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';
import { classifyAgentScreen } from '../../agent-farm/servers/mailbox-wiring.js';
import { OPENCODE_PROFILE } from '../../agent-farm/servers/gate-profiles.js';
import { heldRecoveryAction, heldRecoveryKeystroke } from '../../agent-farm/servers/mailbox-hold-policy.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../agent-farm/__tests__/fixtures/gate', import.meta.url),
);

/** The capture geometry of every `opencode197-*` fixture (Issue #197 re-captures). */
const CAPTURE_COLS = 110;
const CAPTURE_ROWS = 32;

/** The geometry a shellper-backed session is BORN at — `defaultSessionOptions()`. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Every byte the session wrote toward the agent, for the no-keystroke assertions. */
const writes: string[] = [];

beforeEach(() => {
  writes.length = 0;
});

function makeFakeClient(geometry: { cols: number; rows: number } | null): IShellperClient {
  const emitter = new EventEmitter() as unknown as IShellperClient;
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(emitter, 'connected', { get: () => true });
  Object.defineProperty(emitter, 'ptyGeometry', { get: () => geometry });
  (emitter as { write: (d: string) => boolean }).write = (d: string) => {
    writes.push(d);
    return true;
  };
  // Models the DROPPED app-side resize (#1198): the frame never reaches the shellper, so
  // `ptyGeometry` keeps the size the PTY is really at while `PtySession.resize` has already
  // moved the mirror. That divergence is the residual case attach-time adoption cannot fix.
  (emitter as { resize: () => boolean }).resize = () => false;
  return emitter;
}

function makeSession(): PtySession {
  const config: PtySessionConfig = {
    id: 'geom-1',
    command: 'opencode',
    args: [],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: '/tmp',
    env: {},
    label: 'builder-air-197',
    logDir: '/tmp',
    diskLogEnabled: false,
  };
  return new PtySession(config);
}

describe('PtySession.attachShellper — gate-mirror geometry adoption (Issue #197)', () => {
  it('adopts the shellper PTY geometry reported on WELCOME', () => {
    const session = makeSession();
    expect(session.info.rows).toBe(DEFAULT_ROWS);

    session.attachShellper(makeFakeClient({ cols: 108, rows: 60 }), Buffer.alloc(0), 111);

    // 108x60 is a real reading off this machine's fleet, not a round number.
    expect(session.info.cols).toBe(108);
    expect(session.info.rows).toBe(60);
  });

  it('leaves geometry untouched when the shellper reports none (older shellper)', () => {
    const session = makeSession();

    session.attachShellper(makeFakeClient(null), Buffer.alloc(0), 111);

    // "Unknown" is not a licence to overwrite. A shellper too old to send the fields must
    // leave the session exactly where it was, not reset it to a fabricated default.
    expect(session.info.cols).toBe(DEFAULT_COLS);
    expect(session.info.rows).toBe(DEFAULT_ROWS);
  });

  it('an idle opencode builder on a born-default session DELIVERS after adoption', async () => {
    // The whole point of the fix, end to end. A real opencode idle capture, replayed as the
    // attach seed exactly as Tower replays a shellper's history, into a session born at the
    // 80x24 default while the shellper's PTY is at the 110x32 the agent paints at.
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-idle.clean.txt`);

    const session = makeSession();
    session.attachShellper(
      makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }),
      Buffer.alloc(0),
      111,
      undefined,
      seed,
    );

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);
    expect(verdict.clean).toBe(true);
    expect(verdict.detail).toBe('empty');
  });

  it('the same builder HOLDS without adoption — this is the bug, not a hypothetical', async () => {
    // Same session, same seed, same capture: only the WELCOME geometry is withheld, which
    // is precisely the pre-fix behaviour (the fields were on the wire and discarded). The
    // mirror stays at 80x24, opencode's bottom-anchored box is clipped out of the viewport,
    // and every message to this builder holds forever.
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-idle.clean.txt`);

    const session = makeSession();
    session.attachShellper(makeFakeClient(null), Buffer.alloc(0), 111, undefined, seed);

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);
    expect(verdict.clean).toBe(false);
    // `no-composer-marker` — "this app has no composer", i.e. the profile drifted. It had
    // not. This is the mis-signal that sent Issue #197 hunting glyphs for a geometry bug,
    // and at 80x24 it is what the frame-inference checks still say: the mirror is both
    // narrower and shorter, so the screen re-wraps enough that no structural signal
    // survives. Inference cannot close this case; the fact-based check below can.
    expect(verdict.detail).toBe('no-composer-marker');
  });

  it('a mirror that disagrees with the live PTY reports geometry-mismatch, by fact', async () => {
    // The residual divergence adoption cannot close: `PtySession.resize` shrinks the mirror
    // unconditionally and then DROPS the app-side resize on its `status !== 'running'`
    // branches, so the mirror moves and the agent does not. Both geometries are known here,
    // so the gate compares them instead of guessing from the frame — which is what makes
    // this work at 80x24, where every frame-inference signal is destroyed by re-wrapping.
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-idle.clean.txt`);

    const session = makeSession();
    session.attachShellper(
      makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }),
      Buffer.alloc(0),
      111,
      undefined,
      seed,
    );
    // Adoption put the mirror at 110x32 and it classifies clean; now simulate the dropped
    // app-side resize by moving the mirror alone back to the born-default geometry.
    expect((await classifyAgentScreen(session, OPENCODE_PROFILE)).clean).toBe(true);
    session.resize(DEFAULT_COLS, DEFAULT_ROWS);

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);
    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toBe('geometry-mismatch');
  });
});

/**
 * A mid-turn screen on a mismatched mirror must receive NO KEYSTROKE (Issue #197 review,
 * blocking finding 1). Asserted on the BYTES the session wrote, not on a classification —
 * a verdict is an opinion, a written byte is what reaches the agent.
 *
 * The defect this pins: `heldRecoveryAction` maps `geometry-mismatch` to `escape-screen`,
 * i.e. an ESC, and deliberately maps `busy-indicator` to nothing at all because — in that
 * file's own words — "it proves a live turn, so touching it would corrupt active work". The
 * first version of this PR ran the geometry compare BEFORE reading any pixels, so a mid-turn
 * screen on a mismatched mirror classified `geometry-mismatch` and was routed into exactly
 * the keystroke the policy exists to withhold from it. A delivery failure traded for a
 * corruption failure, which is the worse of the two.
 *
 * REACHABILITY, established from source rather than assumed — one reviewer argued this could
 * not co-occur with a live turn, since a resize only fails when the session is not writable
 * and those already hold as `no-live-pty`. That is true at the INSTANT the divergence is
 * created, and false immediately afterwards. `PtySession` has a restart path
 * (`startRestartWait`, #1264) that makes writability come BACK without a re-attach:
 *
 *   1. the child exits → `exitCode` is set → `status === 'exited'`, but the restart path
 *      keeps the WebSocket clients AND the same connected `ShellperClient` (no
 *      `cleanupShellper`);
 *   2. a browser resize during that window moves `this.cols/rows` and the gate mirror, then
 *      hits `status === 'running'` → false, returns without resizing the shellper. The
 *      divergence now exists;
 *   3. the respawned child emits a byte → `cancelCleanup` sets `exitCode = undefined` →
 *      status is `'running'` on the still-connected client → `writable` is true again;
 *   4. no `attachShellper` runs on that path, so geometry adoption never re-syncs it.
 *
 * A live turn on a divergent mirror is therefore reachable, and the ordering is load-bearing
 * rather than defensive.
 */
describe('render gate — a live turn is never handed a recovery keystroke (Issue #197 review)', () => {
  /** Exactly what the delivery path does with a verdict. */
  function applyRecovery(session: PtySession, detail: string | undefined): void {
    const action = heldRecoveryAction(detail);
    if (!action) return;
    // Issue #196 made the recovery keystroke a PER-HARNESS fact, so it is resolved from
    // the target's clear key rather than being a constant. These fakes stand for a
    // `ctrl-c` harness (claude/codex), which is what the `\x03` assertions here encode;
    // on opencode the same action yields Ctrl+U, and on an agent with no recorded clear
    // key it yields null and nothing is written.
    const key = heldRecoveryKeystroke(action, 'ctrl-c');
    if (key) session.write(key);
  }

  it('POSITIVE CONTROL: the harness DOES record a keystroke when one is sent', () => {
    // Without this, every `expect(writes).toEqual([])` below is satisfied just as well by a
    // harness that cannot observe a write at all — a green test proving nothing, which is
    // the same defect as a fixture sweep over an empty directory (#190, #193, #194). This
    // pins the reach: `user-text` still maps to `cancel-draft`, and the byte lands where the
    // assertions look for it.
    const session = makeSession();
    session.attachShellper(makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }), Buffer.alloc(0), 111);

    applyRecovery(session, 'user-text');

    expect(writes).toEqual(['\x03']);
  });


  it('a mid-turn screen on a mismatched mirror writes NO bytes at all', async () => {
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-midturn.busy.txt`);
    const session = makeSession();
    session.attachShellper(
      makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }),
      Buffer.alloc(0),
      111,
      undefined,
      seed,
    );
    // Create the divergence: the mirror moves, the fake's dropped resize leaves the PTY
    // geometry where it was. This is step 2 of the reachability chain above.
    session.resize(DEFAULT_COLS, DEFAULT_ROWS);

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);

    // NOTE what this frame does NOT say. At its 110x32 capture geometry it classifies
    // `busy-indicator`; on this 80x24 mirror the reflow carries opencode's `esc interrupt`
    // footer off-screen, so the busy proof is GONE and the same live turn reads
    // `geometry-mismatch`. Ordering the busy check first cannot rescue this — the proof
    // lives in the very frame whose geometry we distrust. That is why safety here rests on
    // the recovery policy rather than on the classifier's ordering.
    expect(verdict.clean).toBe(false);
    expect(verdict.detail).toBe('geometry-mismatch');

    // ...and `geometry-mismatch` yields no recovery action at all, so a live turn that the
    // gate can no longer recognise as live is still never touched.
    expect(heldRecoveryAction(verdict.detail)).toBeNull();

    applyRecovery(session, verdict.detail);

    // THE assertion: bytes, not opinions. Nothing reached the agent — in particular no ESC
    // (\x1b, escape-screen) and no Ctrl+C (\x03, cancel-draft).
    expect(writes).toEqual([]);
    expect(writes.join('')).not.toContain('\x1b');
    expect(writes.join('')).not.toContain('\x03');
  });

  it('the busy signal still outranks the geometry answer when it survives the frame', async () => {
    // The ordering fix on its own terms: at the capture geometry the busy indicator IS on
    // screen, and a live turn must be named as one rather than as a geometry problem.
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-midturn.busy.txt`);
    const session = makeSession();
    session.attachShellper(
      makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }),
      Buffer.alloc(0),
      111,
      undefined,
      seed,
    );

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);
    expect(verdict.detail).toBe('busy-indicator');
    expect(heldRecoveryAction(verdict.detail)).toBeNull();

    applyRecovery(session, verdict.detail);
    expect(writes).toEqual([]);
  });

  it('an idle mismatched mirror also gets no keystroke — ESC cannot resize a mirror', async () => {
    // Same divergence, an IDLE screen. The mismatch is free to name the verdict here, and it
    // STILL earns no keystroke: the repair for a wrong-sized mirror is a realign, which is
    // Tower's job, not a byte sent to the agent. `isClassifierStuck` lists the detail so this
    // hold escalates to a human rather than starving silently.
    const seed = readFileSync(`${FIXTURE_DIR}/opencode197-idle.clean.txt`);
    const session = makeSession();
    session.attachShellper(
      makeFakeClient({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS }),
      Buffer.alloc(0),
      111,
      undefined,
      seed,
    );
    session.resize(DEFAULT_COLS, DEFAULT_ROWS);

    const verdict = await classifyAgentScreen(session, OPENCODE_PROFILE);
    expect(verdict.detail).toBe('geometry-mismatch');
    expect(heldRecoveryAction(verdict.detail)).toBeNull();

    applyRecovery(session, verdict.detail);
    expect(writes).toEqual([]);
  });
});

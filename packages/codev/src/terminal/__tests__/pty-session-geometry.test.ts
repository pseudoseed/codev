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

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PtySession, type PtySessionConfig } from '../pty-session.js';
import type { IShellperClient } from '../shellper-client.js';
import { classifyAgentScreen } from '../../agent-farm/servers/mailbox-wiring.js';
import { OPENCODE_PROFILE } from '../../agent-farm/servers/gate-profiles.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../agent-farm/__tests__/fixtures/gate', import.meta.url),
);

/** The capture geometry of every `opencode197-*` fixture (Issue #197 re-captures). */
const CAPTURE_COLS = 110;
const CAPTURE_ROWS = 32;

/** The geometry a shellper-backed session is BORN at — `defaultSessionOptions()`. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function makeFakeClient(geometry: { cols: number; rows: number } | null): IShellperClient {
  const emitter = new EventEmitter() as unknown as IShellperClient;
  Object.defineProperty(emitter, 'lastDataAt', { get: () => Date.now() });
  Object.defineProperty(emitter, 'connected', { get: () => true });
  Object.defineProperty(emitter, 'ptyGeometry', { get: () => geometry });
  (emitter as { write: () => boolean }).write = () => true;
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

/** Regression coverage for #92: a static terminal hold must not remain inert forever. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue, getById } from '../db/mailbox.js';
import {
  MailboxDrainer,
  type DeliveryPorts,
  type DeliverySession,
  type HeldRecoveryInfo,
} from '../servers/mailbox-delivery.js';
import {
  heldRecoveryAction,
  heldRecoveryKeystroke,
} from '../servers/mailbox-hold-policy.js';
import type { GateVerdict } from '../servers/render-gate.js';

describe('#92 stuck mailbox hold recovery', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  // The keystroke is now per-harness (#196): `cancel-draft` clears with Ctrl+C on a
  // ctrl-c harness but Ctrl+U on opencode, which quits on Ctrl+C. `escape-screen` is
  // ESC everywhere. These rows carry the clear key the harness table would supply.
  it.each([
    ['user-text', 'cancel-draft', 'ctrl-c', '\x03'],
    ['user-text', 'cancel-draft', 'ctrl-u', '\x15'],
    ['no-region-end', 'escape-screen', 'ctrl-c', '\x1b'],
    ['no-composer-marker', 'escape-screen', 'ctrl-c', '\x1b'],
    // NO `geometry-mismatch` row. #197 removed its recovery action, and this table asserts
    // `heldRecoveryAction(detail) === action` — so a row here would assert the ESC-into-a-
    // live-turn that #197 removed, and make the regression look VERIFIED. Its absence is
    // load-bearing; the explicit null assertion below is what covers it now.
  ] as const)('%s has a bounded recovery action', (detail, action, clearKey, key) => {
    expect(heldRecoveryAction(detail)).toBe(action);
    expect(heldRecoveryKeystroke(action, clearKey)).toBe(key);
  });

  it.each(['busy-indicator', 'no-idle-indicator', null] as const)(
    '%s is never auto-recovered',
    (detail) => expect(heldRecoveryAction(detail)).toBeNull(),
  );

  it('geometry-mismatch is never auto-recovered (Issue #197)', () => {
    // It used to map to `escape-screen`. Removed for two independent reasons.
    //
    // A keystroke cannot fix it: the mirror is the wrong SIZE for the grid the agent paints
    // at, and no byte sent to the agent resizes Tower's mirror. ESC was a no-op dressed as a
    // repair.
    //
    // And it cannot be shown to be safe. Every liveness proof the gate has is read off the
    // same frame whose geometry has just been declared untrustworthy — measured, a real
    // mid-turn opencode capture classifies `busy-indicator` at its 110x32 capture geometry
    // and `geometry-mismatch` on an 80x24 mirror, because the reflow carries the `esc
    // interrupt` footer off-screen. Ordering the busy check first does not rescue that: the
    // proof is destroyed, not outranked. So ESC here could interrupt a live turn to no
    // purpose.
    expect(heldRecoveryAction('geometry-mismatch')).toBeNull();
  });

  it('sends one ESC after no-region-end stays stable, then delivers only after a clean reclassification', async () => {
    let now = 1_000;
    let bytesWritten = 0;
    let verdict: GateVerdict = { clean: false, reason: 'busy', detail: 'no-region-end' };
    const controlWrites: string[] = [];
    const messageWrites: string[] = [];
    const recoveries: HeldRecoveryInfo[] = [];
    const session: DeliverySession = {
      get bytesWritten() { return bytesWritten; },
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write(data: string) { controlWrites.push(data); return true; },
    };
    const ports: DeliveryPorts = {
      getSessionForAgent: () => session,
      resolveProfile: () => ({ app: 'claude', markerPattern: /^>/, regionEndPatterns: [] }),
      classify: async () => verdict,
      writeMessage: (_session, message) => { messageWrites.push(message); return true; },
      broadcast: () => undefined,
      onHeldStateChange: () => undefined,
      onEscalation: () => undefined,
      onLiveness: () => undefined,
      recoverHeld: (info) => {
        recoveries.push(info);
        session.write(heldRecoveryKeystroke(info.action, 'ctrl-c')!);
        // Model the app repaint caused by ESC. The drainer may not bypass the gate:
        // output changes first, and only the NEXT pass can classify and deliver.
        bytesWritten++;
        verdict = { clean: true, detail: 'empty' };
        return true;
      },
      log: () => undefined,
      now: () => now,
    };
    const row = enqueue(db, {
      workspacePath: '/ws/a',
      toAgent: 'bugfix-47',
      body: 'continue',
      formattedMessage: '[architect] continue',
    }, now);
    const drainer = new MailboxDrainer({
      intervalMs: 999_999,
      escalationMs: 999_999,
      recoveryMs: 10_000,
    });
    drainer.start(ports, db);

    await drainer.tick(); // first observation starts the stable-verdict clock
    now += 9_999;
    bytesWritten++; // same unreadable verdict, but the app is still producing output
    await drainer.tick();
    expect(recoveries).toHaveLength(0);

    now += 9_999;
    await drainer.tick();
    expect(recoveries).toHaveLength(0); // screen motion reset the safety window

    now += 1;
    await drainer.tick(); // recovery only; message is still gated and held
    expect(recoveries).toEqual([{
      workspacePath: '/ws/a',
      toAgent: 'bugfix-47',
      detail: 'no-region-end',
      action: 'escape-screen',
      stableMs: 10_000,
    }]);
    expect(controlWrites).toEqual(['\x1b']);
    expect(messageWrites).toHaveLength(0);
    expect(getById(db, row.id)?.status).toBe('held');

    await drainer.tick();
    expect(messageWrites).toEqual(['[architect] continue']);
    expect(getById(db, row.id)?.status).toBe('delivered');
    drainer.stop();
  });
});

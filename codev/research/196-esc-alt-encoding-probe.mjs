/**
 * Issue #196 — live evidence that ESC immediately followed by Ctrl+U is swallowed.
 *
 * The CMAP review raised a blocking finding no unit test can settle: ESC followed
 * immediately by a character is the standard terminal encoding for Alt+character, so
 * `\x1b\x15` written back-to-back may reach the TUI as ONE alt-modified keypress rather
 * than two keystrokes. Only a real TUI can answer what it does with a byte stream.
 *
 * RESULT, opencode 1.18.18, 2026-08-29 (detection: opencode draws its `Ask anything...`
 * placeholder ONLY when the composer is empty, so the placeholder returning in the
 * post-clear redraw is the cleared signal):
 *
 *   [A] UNSPACED ESC+Ctrl+U, one write   survived: true   cleared: FALSE
 *   [B] SETTLED  ESC, 50ms, Ctrl+U       survived: true   cleared: TRUE
 *   [C] CONTROL  Ctrl+U alone            survived: true   cleared: TRUE
 *
 * [A] is what the pre-review code did: it did not quit opencode, so nothing looked wrong,
 * and it did not clear the draft either — `--interrupt` would have reported success having
 * done nothing. [C] is what makes [A] meaningful: Ctrl+U alone clears, so [A] fails because
 * of the ESC in front of it, not because Ctrl+U is the wrong key.
 *
 * Run:  cd packages/codev && PROBE_OUT=/tmp/p.out node ../../codev/research/196-esc-alt-encoding-probe.mjs
 * (from packages/codev so `node-pty` resolves; needs a real `opencode` on PATH.)
 */
import { spawn } from 'node-pty';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.PROBE_OUT ?? './196-probe.out';
const log = (m) => appendFileSync(OUT, m + '\n');
const ESC = '\x1b', CTRL_U = '\x15';
const SETTLE = 50;                     // ESCAPE_ENTER_DELAY_MS
const MARK = 'ZZMARKERZZ';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function arm(label, clearFn) {
  const cwd = mkdtempSync(join(tmpdir(), 'b196-'));
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ instructions: [] }));
  let buf = '', exited = false;
  const pty = spawn('opencode', [], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env });
  pty.onData(d => { buf += d; });
  pty.onExit(() => { exited = true; });

  await sleep(11000);
  if (exited) { log(label + ' :: OPENCODE EXITED DURING BOOT'); return; }

  pty.write(MARK);
  await sleep(2000);
  const typed = clean(buf).includes(MARK);
  buf = '';

  await clearFn(pty);
  await sleep(2500);
  const after = clean(buf);
  const markerStillDrawn = after.includes(MARK);
  const placeholderBack = after.includes('Ask anything');

  log(label);
  log('   draft was typed      : ' + typed);
  log('   process survived     : ' + !exited);
  log('   marker in redraw     : ' + markerStillDrawn);
  log('   placeholder returned : ' + placeholderBack + (placeholderBack ? '   <= COMPOSER CLEARED' : ''));
  try { pty.kill('SIGKILL'); } catch {}
  await sleep(500);
}

await arm('[A] UNSPACED  ESC+Ctrl+U in ONE write', async (p) => { p.write(ESC + CTRL_U); });
await arm('[B] SETTLED   ESC, 50ms, Ctrl+U  (the fix)', async (p) => { p.write(ESC); await sleep(SETTLE); p.write(CTRL_U); });
await arm('[C] CONTROL   Ctrl+U alone', async (p) => { p.write(CTRL_U); });
log('=== done ===');
process.exit(0);

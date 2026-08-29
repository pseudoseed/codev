/**
 * Drive a real opencode TUI under a PTY and dump the raw byte stream for each composer state
 * (Issue #197). This is how the `opencode197-*` render-gate fixtures were produced.
 *
 * Reusable for ANY TUI whose gate profile needs measuring — change the binary and the states.
 * The output is the raw PTY stream, which is exactly what the gate classifies, so a dump can
 * be dropped straight into `packages/codev/src/agent-farm/__tests__/fixtures/gate/`.
 *
 *   node capture-opencode-frames.cjs <out-dir> [cols] [rows] [work-dir]
 *
 * Requires node-pty resolvable from the repo (run `pnpm install` at the root first) and an
 * authenticated opencode. Costs one real model turn.
 */
const { createRequire } = require('node:module');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Resolve node-pty out of the repo's own install rather than a hardcoded path.
const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: __dirname }).toString().trim();
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
const pty = requireFromRepo('node-pty');

const OUT = process.argv[2] || process.cwd();
const COLS = Number(process.argv[3] || 110);
const ROWS = Number(process.argv[4] || 32);
const WORK = process.argv[5] || process.cwd();
const BIN = process.env.OPENCODE_BIN || 'opencode';

let buf = '';
const p = pty.spawn(BIN, [], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: WORK,
  env: { ...process.env, TERM: 'xterm-256color' },
});
p.onData((d) => { buf += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = (name) => {
  fs.writeFileSync(path.join(OUT, name), buf, 'utf8');
  console.log(`[dump] ${name} bytes=${Buffer.byteLength(buf)}`);
};

(async () => {
  await sleep(9000);
  dump('live-boot.txt');            // booted, no turn yet -> no-idle-indicator

  p.write('what is 2+2? answer with just the number and nothing else');
  await sleep(2500);
  dump('live-boot-draft.txt');      // draft on a never-run session

  p.write('\r');
  await sleep(2500);
  dump('live-midturn.txt');         // generating -> busy-indicator

  await sleep(25000);
  dump('live-idle.txt');            // completed turn, empty composer -> CLEAN

  p.write('a second draft line that is long enough to be interesting');
  await sleep(2000);
  dump('live-draft.txt');           // typed draft -> user-text

  for (let i = 0; i < 70; i++) p.write('\x7f');
  await sleep(1500);
  dump('live-idle2.txt');           // cleared again -> CLEAN

  p.kill();
  await sleep(500);
  process.exit(0);
})();

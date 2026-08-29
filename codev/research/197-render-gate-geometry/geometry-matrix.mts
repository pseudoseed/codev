/**
 * The cols x rows verdict matrix for one opencode capture (Issue #197).
 *
 * QUESTION IT ANSWERS: what does the render gate say when its mirror disagrees with the
 * geometry the agent painted at, in each direction and in both at once?
 *
 * WHAT IT MEASURED. Run against `opencode197-midturn.busy.txt` this is the finding that
 * invalidated the first fix for the review's blocking issue. A live turn classifies
 * `busy-indicator` at its 110x32 capture geometry, but once the mirror is short enough the
 * reflow carries opencode's `esc interrupt` footer off the viewport, the busy proof VANISHES,
 * and the same live turn classifies `geometry-mismatch`. Exact boundary, as printed:
 *
 *     rows <= 28  ->  geometry-mismatch at every width measured (80..120)
 *     rows >= 31  ->  busy-indicator retained at cols 90..120
 *     cols 80     ->  geometry-mismatch at EVERY height (narrow enough to break it alone)
 *
 * So it is not "any smaller mirror" — the proof survives a mildly short one and is destroyed
 * by a sufficiently short or narrow one. That is enough: the liveness proof is read off the
 * very frame whose geometry is untrusted, so whether it survives depends on how wrong the
 * geometry happens to be. It cannot be relied on. That is why `geometry-mismatch` earns no
 * recovery keystroke at all, rather than merely losing a race with the busy check — ordering
 * would have protected the frames that did not need protecting.
 *
 * Run against `opencode197-idle.clean.txt` it shows the other half: clean at and above the
 * capture geometry, held below it.
 *
 *   pnpm exec tsx geometry-matrix.mts [fixture-name]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SRC } from './_paths.mts';
const { RingBuffer } = await import(join(SRC, 'terminal/ring-buffer.js'));
const { classifyScreen } = await import(join(SRC, 'agent-farm/servers/render-gate.js'));
const { OPENCODE_PROFILE } = await import(join(SRC, 'agent-farm/servers/gate-profiles.js'));

const name = process.argv[2] ?? 'opencode197-midturn.busy.txt';
const ring = new RingBuffer(1000);
ring.pushData(readFileSync(join(FIXTURES, name), 'utf8'));
const replay = ring.getAll().join('\n');

console.log(`${name}\ncols rows  verdict`);
for (const cols of [80, 90, 100, 110, 120]) {
  for (const rows of [20, 24, 28, 31, 32, 60]) {
    const v = await classifyScreen({ replay, cols, rows }, OPENCODE_PROFILE);
    console.log(`${String(cols).padStart(4)} ${String(rows).padStart(4)}  ${v.clean ? 'CLEAN' : 'busy'}/${v.detail}`);
  }
}

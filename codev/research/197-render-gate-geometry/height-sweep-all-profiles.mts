/**
 * Classify each app's IDLE capture across mirror heights 10..40 (Issue #197).
 *
 * QUESTION IT ANSWERS: does a mirror shorter than the agent's PTY break every harness, or
 * only opencode?
 *
 * WHAT IT MEASURED:
 *   claude    clean at every height 10..40
 *   agy       clean at every height 10..40
 *   codex     holds below 20
 *   opencode  holds below 32 (its capture height)
 *
 * WHY IT MATTERS TO #202. claude, codex and agy survive a short mirror because their
 * composers sit at the cursor and stay in view — NOT because anything guarantees it. They are
 * correct by luck. A claude that grew its composer downward would fail exactly as opencode
 * did, silently, and nothing in the gate would say so. Anyone widening the fact-based
 * geometry check past `bottomAnchor` profiles is deciding what a mirror/PTY disagreement
 * should mean for those three, and this is the evidence about how they actually behave.
 *
 *   pnpm exec tsx height-sweep-all-profiles.mts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SRC } from './_paths.mts';
const { RingBuffer } = await import(join(SRC, 'terminal/ring-buffer.js'));
const { classifyScreen } = await import(join(SRC, 'agent-farm/servers/render-gate.js'));
const P: any = await import(join(SRC, 'agent-farm/servers/gate-profiles.js'));

const CASES: Array<[string, any]> = [
  ['claude-idle.clean.txt', P.CLAUDE_PROFILE],
  ['codex-idle.clean.txt', P.CODEX_PROFILE],
  ['agy-idle.clean.txt', P.AGY_PROFILE],
  ['opencode197-idle.clean.txt', P.OPENCODE_PROFILE],
];

for (const [name, profile] of CASES) {
  const ring = new RingBuffer(1000);
  ring.pushData(readFileSync(join(FIXTURES, name), 'utf8'));
  const replay = ring.getAll().join('\n');
  const tally: Record<string, number[]> = {};
  for (let rows = 10; rows <= 40; rows++) {
    const v = await classifyScreen({ replay, cols: 110, rows }, profile);
    (tally[`${v.clean ? 'CLEAN' : 'busy'}/${v.detail}`] ??= []).push(rows);
  }
  console.log(`\n=== ${name} (cols=110) ===`);
  for (const [k, rs] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(26)} rows ${rs[0]}..${rs[rs.length - 1]}  (n=${rs.length})`);
  }
}

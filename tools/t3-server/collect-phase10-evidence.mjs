/**
 * Spec 146 Phase 10 — assemble the recorded runs into the committed evidence.
 *
 * `full-protocol-run.sh` leaves one JSON per run in the gitignored
 * `.runtime-runs/`. This turns those into
 * `codev/research/146-phase10-live-evidence.json` and fills the results table in
 * `codev/research/146-driver-parity.md` between its markers.
 *
 * A SCRIPT RATHER THAN A HAND STEP, FOR ONE REASON
 *
 * `spec-146-phase-10-full-protocol.test.ts` refuses evidence older than the
 * runner that produced it, so the evidence has to be regenerated whenever the
 * runs are. A regeneration procedure that lives only in someone's memory is one
 * that gets done differently the second time — and the difference would land in
 * a file whose whole job is to be trustworthy.
 *
 *   node tools/t3-server/collect-phase10-evidence.mjs claude-1h opencode-1h
 *
 * The long gate is named separately, because it is RUNNING rather than finished
 * and only its start is this phase's deliverable:
 *
 *   --long-gate <label> --long-gate-started <iso8601>
 *
 * Exit 3 — not 1 — when a named run is missing or unreadable. "I could not read
 * the evidence" and "the evidence says the run failed" are different facts, and
 * this script never gets to make the second claim on the strength of the first.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runsDir = join(repoRoot, 'tools', 't3-server', '.runtime-runs');
const evidencePath = join(repoRoot, 'codev', 'research', '146-phase10-live-evidence.json');
const parityPath = join(repoRoot, 'codev', 'research', '146-driver-parity.md');

const argv = process.argv.slice(2);
const labels = [];
let longGateLabel = null;
let longGateStarted = null;
let longGateHarness = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--long-gate') longGateLabel = argv[++i];
  else if (argv[i] === '--long-gate-started') longGateStarted = argv[++i];
  else if (argv[i] === '--long-gate-harness') longGateHarness = argv[++i];
  else labels.push(argv[i]);
}

if (labels.length === 0) {
  console.error('usage: collect-phase10-evidence.mjs <label>... [--long-gate <label> --long-gate-started <iso>]');
  process.exit(2);
}

const runs = [];
for (const label of labels) {
  const path = join(runsDir, `${label}.json`);
  if (!existsSync(path)) {
    console.error(`MISSING_RUN: could not check: ${path} does not exist. The run for "${label}" has not `
      + 'finished, or wrote its evidence somewhere else. This is not "the run failed".');
    process.exit(3);
  }
  try {
    runs.push(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    console.error(`UNREADABLE_RUN: could not check: ${path} is not readable JSON (${error.message}).`);
    process.exit(3);
  }
}

if (longGateLabel !== null && longGateStarted === null) {
  console.error('MISSING_START: could not check: --long-gate was given without --long-gate-started. The '
    + "long gate's deliverable is its recorded START, so recording it without one records nothing.");
  process.exit(3);
}
if (longGateLabel !== null && longGateHarness === null) {
  // It used to default to 'claude'. A run that says which driver produced it is
  // the rule this whole program is built on, and a hardcoded default is that
  // rule with the answer written in advance.
  console.error('MISSING_HARNESS: could not check: --long-gate was given without --long-gate-harness. '
    + 'Every recorded run says which driver produced it; the long gate does not get an exception.');
  process.exit(3);
}

/**
 * Content hashes of the code the evidence describes.
 *
 * These replace an mtime comparison, which both review lanes flagged
 * independently and which was another assertion that could not fail: git does
 * not preserve mtimes, so a clean checkout randomises the comparison, and
 * `touch` bypasses it outright. A hash is the same answer on every machine and
 * cannot be satisfied by anything except the bytes.
 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const describes = {
  'packages/codev/src/agent-farm/__tests__/helpers/air-235-full-protocol.mjs': null,
  'packages/codev/src/agent-farm/__tests__/helpers/air-235-pty-witness.mjs': null,
  'packages/codev/src/agent-farm/__tests__/helpers/air-235-resubscribe.mjs': null,
  // The launcher is here because it changes what a run MEANS, not just how it is
  // started: it writes the provider opt-in without which a turn on some drivers
  // is refused outright, and it decides that each run owns its own port and
  // state directory. Evidence gathered by a launcher that had lost the opt-in
  // would describe a different experiment.
  'tools/t3-server/full-protocol-run.sh': null,
};
for (const relative of Object.keys(describes)) {
  const absolute = join(repoRoot, relative);
  if (!existsSync(absolute)) {
    console.error(`MISSING_SOURCE: could not check: ${relative} does not exist, so the evidence cannot record `
      + 'what code produced it.');
    process.exit(3);
  }
  describes[relative] = sha256(absolute);
}

const evidence = {
  _comment:
    'Spec 146 Phase 10. Generated by tools/t3-server/collect-phase10-evidence.mjs from the runs in '
    + 'tools/t3-server/.runtime-runs/. Do not hand-edit: spec-146-phase-10-full-protocol.test.ts asserts '
    + 'this against the runner that produced it.',
  recordedAt: new Date().toISOString(),
  server: {
    pinnedCommit: JSON.parse(readFileSync(join(repoRoot, 'packages/types/src/t3/pin.json'), 'utf8')).commit,
    pinnedCli: JSON.parse(readFileSync(join(repoRoot, 'packages/types/src/t3/pin.json'), 'utf8')).cliVersion,
    interpreter: 'Node 26.4.0 (outside t3code engines.node ^24.13.1; the harness emits its ADVISORY and continues)',
    bind: '127.0.0.1 only, one server and one data directory per run',
  },
  describes,
  runs,
  ...(longGateLabel === null
    ? {}
    : {
        longGate: {
          label: longGateLabel,
          startedAt: longGateStarted,
          gateSeconds: 86_400,
          harness: longGateHarness,
        },
      }),
};

writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

// ── the parity table ────────────────────────────────────────────────────────
const rows = runs
  .map((run) => {
    const outcomes = Object.values(run.criteria).map((c) => c.outcome);
    const met = outcomes.filter((o) => o === 'met').length;
    const seconds = Math.round(
      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
    );
    return `| \`${run.harness}\` / \`${run.model}\` | \`${run.driverKind}\` | ${run.gateSeconds}s `
      + `| ${met}/${outcomes.length} met | ${seconds}s end to end |`;
  })
  .join('\n');

const table = `
| Run | Driver kind | Gate | Criteria | Wall clock |
|---|---|---|---|---|
${rows}

Every criterion above is \`met\`. The runner records \`met\`, \`not-met\` and \`undetermined\`
separately and the test accepts only \`met\`, so a criterion that could not be evaluated cannot
hide inside this table.
`;

const parity = readFileSync(parityPath, 'utf8');
const begin = parity.indexOf('<!-- results:begin -->');
const end = parity.indexOf('<!-- results:end -->');
if (begin === -1 || end === -1) {
  console.error('NO_MARKERS: could not check: 146-driver-parity.md has no results:begin/results:end markers.');
  process.exit(3);
}
writeFileSync(
  parityPath,
  `${parity.slice(0, begin)}<!-- results:begin -->\n${table}\n${parity.slice(end)}`,
);

console.log(`wrote ${evidencePath}`);
for (const [relative, hash] of Object.entries(describes)) {
  console.log(`  describes ${relative} @ ${hash.slice(0, 12)}`);
}
console.log(`filled the results table in ${parityPath}`);
for (const run of runs) {
  const notMet = Object.entries(run.criteria).filter(([, c]) => c.outcome !== 'met');
  console.log(
    `  ${run.harness}/${run.driverKind}: ${Object.keys(run.criteria).length} criteria, `
    + (notMet.length === 0 ? 'all met' : `NOT MET: ${notMet.map(([k, c]) => `${k}=${c.outcome}`).join(', ')}`),
  );
}

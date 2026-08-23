import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapCommands } from './map-commands.mjs';
import { scoreLayout } from './score-layout.mjs';
import { scorePicker } from './score-picker.mjs';
import { probeTower } from './probe-tower.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const commands = mapCommands();
const layout = scoreLayout();
const picker = scorePicker();
const tower = await probeTower();

writeFileSync(join(artifacts, 'command-map.json'), `${JSON.stringify(commands, null, 2)}\n`);
writeFileSync(join(artifacts, 'layout-score.json'), `${JSON.stringify(layout, null, 2)}\n`);
writeFileSync(join(artifacts, 'picker-score.json'), `${JSON.stringify(picker, null, 2)}\n`);
writeFileSync(join(artifacts, 'tower-probe.json'), `${JSON.stringify(tower, null, 2)}\n`);

const summary = {
  generatedAt: new Date().toISOString(),
  startGone: commands.startGone,
  remoteGone: commands.remoteGone,
  createEmptyStatus: tower.createEmpty?.status ?? null,
  updateStatus: tower.updateMissing?.status ?? null,
  ptySawHello: tower.pty?.sawHello ?? false,
  ptyExitCode: tower.pty?.exitCode ?? null,
  ptyControlHasExit: tower.pty?.controlHasExit ?? null,
  oneRowPerWorkspace: layout.oneRowPerWorkspace,
  currentIsOneRow: layout.currentIsOneRow,
  nativePickerWorks: picker.nativePickerGivesAbsolutePathInBrowser,
};
writeFileSync(join(artifacts, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const md = [
  '# Experiment 63 run',
  '',
  `Generated ${summary.generatedAt}`,
  '',
  '| Metric | Value |',
  '|---|---|',
  `| \`afx start\` gone | ${summary.startGone} |`,
  `| \`afx start --remote\` gone | ${summary.remoteGone} |`,
  `| POST /api/create {} | ${summary.createEmptyStatus} |`,
  `| POST /api/update | ${summary.updateStatus} |`,
  `| PTY streamed hello-0063 | ${summary.ptySawHello} |`,
  `| PTY exitCode | ${summary.ptyExitCode} |`,
  `| WS control had exit | ${summary.ptyControlHasExit} |`,
  `| Flattened is one row | ${summary.oneRowPerWorkspace} |`,
  `| Current card is one row | ${summary.currentIsOneRow} |`,
  `| Native picker gives abs path | ${summary.nativePickerWorks} |`,
  '',
].join('\n');
writeFileSync(join(artifacts, 'run.md'), md);
console.log(md);

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function probe(label, argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 15000,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const firstLine = out.split('\n').find((line) => line.trim()) || '';
  return {
    label,
    argv,
    status: result.status,
    error: result.error ? result.error.message : null,
    firstLine,
    knownMissing:
      /unknown command|unknown option|Did you mean/i.test(out) ||
      result.error?.code === 'ENOENT',
  };
}

function commandMissing(p) {
  if (p.knownMissing) return true;
  if (p.error) return true;
  // `afx start --help` prints the root usage and exits 0. That is not a start command.
  if (/^Usage: afx \[options\] \[command\]/.test(p.firstLine)) return true;
  return false;
}

export function mapCommands() {
  const probes = [
    probe('spec: afx start', ['afx', 'start']),
    probe('spec: afx start --help', ['afx', 'start', '--help']),
    probe('spec: afx start --remote', ['afx', 'start', '--remote']),
    probe('current: afx workspace start --help', ['afx', 'workspace', 'start', '--help']),
    probe('current: afx tower connect --help', ['afx', 'tower', 'connect', '--help']),
    probe('current: codev init --help', ['codev', 'init', '--help']),
    probe('current: codev adopt --help', ['codev', 'adopt', '--help']),
    probe('current: codev update --help', ['codev', 'update', '--help']),
  ];

  const buttons = [
    {
      button: 'Open Dashboard (Local)',
      specCommand: 'afx start',
      current: 'POST /api/launch { workspacePath } (same as afx workspace start)',
      verdict: 'maps-to-different-command',
    },
    {
      button: 'Open Dashboard (Remote)',
      specCommand: 'afx start --remote user@host:/path',
      current: 'gone. afx tower connect is Codev Cloud, not SSH start',
      verdict: 'missing',
    },
    {
      button: 'Create New Repo',
      specCommand: 'codev init',
      current: 'POST /api/create { parent, name } runs codev init --yes, then launch',
      verdict: 'maps',
    },
    {
      button: 'Adopt Existing Repo',
      specCommand: 'codev adopt',
      current: 'implicit inside launchInstance when codev/ is absent',
      verdict: 'maps-implicit',
    },
    {
      button: 'Update Existing Repo',
      specCommand: 'codev update',
      current: 'CLI only. no /api/update',
      verdict: 'missing',
    },
  ];

  const startProbe = probes.find((p) => p.label === 'spec: afx start');
  const helpProbe = probes.find((p) => p.label === 'spec: afx start --help');
  const remoteProbe = probes.find((p) => p.label === 'spec: afx start --remote');
  const startGone = commandMissing(startProbe) && commandMissing(helpProbe);
  const remoteGone = commandMissing(remoteProbe);

  return {
    generatedAt: new Date().toISOString(),
    startGone,
    remoteGone,
    probes,
    buttons,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = mapCommands();
  const out = join(root, 'artifacts', 'command-map.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(out);
}

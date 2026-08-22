import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'artifacts', 'repro-last-writer-wins.txt');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const lines: string[] = [];
function log(line: string): void {
  lines.push(line);
}

async function main(): Promise<void> {
  const modulePath =
    process.env.PTY_SESSION_MODULE ||
    path.resolve('/Users/chris/dev/codev-1455/packages/codev/src/terminal/pty-session.ts');
  log(`date: ${new Date().toISOString()}`);
  log(`PTY_SESSION_MODULE: ${modulePath}`);
  log(`method: PtySession.resize (last writer wins)`);
  log('');

  const { PtySession } = await import(pathToFileURL(modulePath).href);

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp38-repro-'));
  const session = new PtySession({
    id: 'exp38-repro',
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cols: 80,
    rows: 24,
    cwd: os.tmpdir(),
    env: { ...process.env, TERM: 'xterm-256color', PS1: '' } as Record<string, string>,
    label: 'exp38-repro',
    logDir,
    diskLogEnabled: false,
  });

  const output: string[] = [];
  const clientA = { send: (data: Buffer | string) => output.push(`A:${String(data)}`) };
  const clientB = { send: (data: Buffer | string) => output.push(`B:${String(data)}`) };

  let spawned = false;
  try {
    await session.spawn();
    spawned = true;
    log('spawn: ok (/bin/bash)');
  } catch (error) {
    log(`spawn: failed (${error instanceof Error ? error.message : String(error)})`);
    log('continuing with session.info only');
  }

  session.attach(clientA);
  session.attach(clientB);
  log(`clients attached: ${session.clientCount}`);
  log(`initial session.info: cols=${session.info.cols} rows=${session.info.rows}`);

  session.resize(80, 24);
  log(`after client A resize(80, 24): cols=${session.info.cols} rows=${session.info.rows}`);

  session.resize(40, 12);
  log(`after client B resize(40, 12): cols=${session.info.cols} rows=${session.info.rows}`);

  const infoWins = session.info.cols === 40 && session.info.rows === 12;
  log(`session.info last-writer-wins: ${infoWins ? 'YES' : 'NO'}`);

  if (spawned) {
    output.length = 0;
    session.write('stty size\n');
    await sleep(400);
    const stty = output.join('').replace(/\r/g, '');
    log(`stty size after B won (raw): ${JSON.stringify(stty)}`);
    const match = stty.match(/(\d+)\s+(\d+)/);
    if (match) {
      log(`stty parsed: rows=${match[1]} cols=${match[2]}`);
    } else {
      log('stty: no parseable size in captured output');
    }
    session.kill();
  }

  log('');
  log('conclusion:');
  log(
    infoWins
      ? 'Two sequential resize() calls from two attached clients leave session.info at the later writer.'
      : 'Could not reproduce last-writer-wins on session.info.',
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(`wrote ${outPath}\n`);
  if (!infoWins) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

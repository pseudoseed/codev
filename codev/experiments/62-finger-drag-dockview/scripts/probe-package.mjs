import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'node_modules', 'dockview-core');
const WRAP = path.join(ROOT, 'node_modules', 'dockview-react');
const ARTIFACTS = path.join(ROOT, 'artifacts');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.(js|mjs|cjs|d\.ts)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const NEEDLES = [
  'dndStrategy',
  'pointer',
  'long-press',
  'longPress',
  'touch',
  'PointerEvent',
  'pointerdown',
];

function scan(files) {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const found = NEEDLES.filter((n) => text.includes(n));
    if (!found.length) continue;
    hits.push({
      file: path.relative(ROOT, file),
      needles: found,
      bytes: text.length,
    });
  }
  return hits;
}

const corePkg = fs.existsSync(path.join(CORE, 'package.json'))
  ? readJson(path.join(CORE, 'package.json'))
  : null;
const wrapPkg = fs.existsSync(path.join(WRAP, 'package.json'))
  ? readJson(path.join(WRAP, 'package.json'))
  : null;

const files = [...walk(CORE), ...walk(WRAP)];
const hits = scan(files);

const pointerFiles = hits.filter((h) =>
  h.needles.some((n) => ['dndStrategy', 'pointerdown', 'PointerEvent', 'longPress', 'long-press'].includes(n)),
);

const report = {
  at: new Date().toISOString(),
  dockview: wrapPkg?.version ?? null,
  dockviewCore: corePkg?.version ?? null,
  filesScanned: files.length,
  hitCount: hits.length,
  pointerBackendPresent: pointerFiles.length > 0,
  pointerFiles,
  allHits: hits,
};

fs.mkdirSync(ARTIFACTS, { recursive: true });
const out = path.join(ARTIFACTS, 'package-probe.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  dockview: report.dockview,
  dockviewCore: report.dockviewCore,
  filesScanned: report.filesScanned,
  pointerBackendPresent: report.pointerBackendPresent,
  pointerFiles: pointerFiles.map((h) => h.file),
  wrote: path.relative(ROOT, out),
}, null, 2));

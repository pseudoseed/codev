import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseHex(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function lin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function lum(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const L1 = lum(a);
  const L2 = lum(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(fg, bg, alpha) {
  const f = parseHex(fg);
  const b = parseHex(bg);
  const r = Math.round(f.r * alpha + b.r * (1 - alpha));
  const g = Math.round(f.g * alpha + b.g * (1 - alpha));
  const bl = Math.round(f.b * alpha + b.b * (1 - alpha));
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function invert(hex) {
  const { r, g, b } = parseHex(hex);
  return `#${[255 - r, 255 - g, 255 - b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

// Rough chroma: distance from grey of the same value. Not OKLCH. Good enough to rank rust vs ochre vs moss.
function chroma(hex) {
  const { r, g, b } = parseHex(hex);
  const avg = (r + g + b) / 3;
  return Math.sqrt((r - avg) ** 2 + (g - avg) ** 2 + (b - avg) ** 2);
}

const light = {
  bone: '#EDE8DE',
  chalk: '#F6F3EB',
  concrete: '#DAD3C4',
  ink: '#221F1A',
  graphite: '#4A463D',
  rust: '#B5502A',
  rustdark: '#8C3D1F',
  ochre: '#C08A2E',
  moss: '#5C6B4F',
};

// Designed night-workshop candidate. Edited only when the harness fails a pairing.
const dark = {
  bone: '#2A251E',
  chalk: '#353027',
  concrete: '#8A8070',
  ink: '#EDE4D4',
  graphite: '#C4B8A4',
  well: '#0A0908',
  rust: '#ED7C48',
  rustdark: '#D26432',
  ochre: '#D9A84C',
  moss: '#9AAA86',
};

function pair(name, fg, bg, kind) {
  const ratio = contrast(fg, bg);
  const need = kind === 'text' ? 4.5 : kind === 'large' ? 3 : 3;
  return {
    name,
    fg,
    bg,
    kind,
    ratio: Number(ratio.toFixed(2)),
    need,
    pass: ratio + 1e-9 >= need,
  };
}

function score(p) {
  const wellOnBone = contrast(p.well, p.bone);
  const wellOnChalk = contrast(p.well, p.chalk);
  const rows = [
    pair('ink on bone (body)', p.ink, p.bone, 'text'),
    pair('ink on chalk (header, tickets, plots)', p.ink, p.chalk, 'text'),
    pair('graphite on bone (machine meta)', p.graphite, p.bone, 'text'),
    pair('graphite on chalk (ticket body, footer)', p.graphite, p.chalk, 'text'),
    pair('graphite on chalk, no fade (held time)', p.graphite, p.chalk, 'text'),
    pair('ink on well (terminal, rail chrome)', p.ink, p.well, 'text'),
    pair('ink/85 on well (terminal body)', mix(p.ink, p.well, 0.85), p.well, 'text'),
    pair('ink/70 on well (GATE QUEUE)', mix(p.ink, p.well, 0.7), p.well, 'text'),
    pair('ink/65 on well (rail footer)', mix(p.ink, p.well, 0.65), p.well, 'text'),
    pair('rust on bone (footer 3 gates)', p.rust, p.bone, 'text'),
    pair('rust on chalk (GATE stamp)', p.rust, p.chalk, 'text'),
    pair('rust on chalk large (held 24:07)', p.rust, p.chalk, 'large'),
    pair('rust on well (3 waiting, awaiting gate)', p.rust, p.well, 'text'),
    pair('ochre on chalk (STUCK?)', p.ochre, p.chalk, 'text'),
    pair('ochre on well (terminal warning)', p.ochre, p.well, 'text'),
    pair('moss on bone (online badge)', p.moss, p.bone, 'text'),
    pair('moss on chalk (spark is graphic; badge-on-plot)', p.moss, p.chalk, 'ui'),
    pair('well on rust (badge glyph, Approve drop)', p.well, p.rust, 'text'),
    pair('ink border on bone (plot, workspace)', p.ink, p.bone, 'ui'),
    pair('ink border on chalk (header, ticket)', p.ink, p.chalk, 'ui'),
    pair('concrete on bone (grid, divider)', p.concrete, p.bone, 'ui'),
    pair('rust border on chalk (needs-attn ticket)', p.rust, p.chalk, 'ui'),
    pair('ochre border on chalk (stuck row)', p.ochre, p.chalk, 'ui'),
    pair('moss on bone (online pip)', p.moss, p.bone, 'ui'),
    pair('ink border of a well on bone (terminal edge)', p.ink, p.bone, 'ui'),
    pair('rust border of a well on bone (gate terminal)', p.rust, p.bone, 'ui'),
  ];
  return {
    tokens: p,
    wellOnBone: Number(wellOnBone.toFixed(2)),
    wellOnChalk: Number(wellOnChalk.toFixed(2)),
    wellDarkerThanBone: lum(p.well) < lum(p.bone),
    chroma: {
      rust: Number(chroma(p.rust).toFixed(1)),
      ochre: Number(chroma(p.ochre).toFixed(1)),
      moss: Number(chroma(p.moss).toFixed(1)),
    },
    rustLoudest: chroma(p.rust) > chroma(p.ochre) && chroma(p.rust) > chroma(p.moss),
    rows,
    failed: rows.filter((r) => !r.pass),
  };
}

const designed = score(dark);

const inverted = {
  bone: invert(light.bone),
  chalk: invert(light.chalk),
  concrete: invert(light.concrete),
  ink: invert(light.ink),
  graphite: invert(light.graphite),
  well: invert(light.ink),
  rust: invert(light.rust),
  rustdark: invert(light.rustdark),
  ochre: invert(light.ochre),
  moss: invert(light.moss),
};
const invertScore = score(inverted);

const out = {
  generatedAt: new Date().toISOString(),
  designed,
  invertControl: {
    tokens: inverted,
    wellOnBone: invertScore.wellOnBone,
    wellDarkerThanBone: invertScore.wellDarkerThanBone,
    rustLoudest: invertScore.rustLoudest,
    chroma: invertScore.chroma,
    failed: invertScore.failed,
    note: 'Mechanical invert of the light palette. well is inverted ink. Expected to flatten.',
  },
};

writeFileSync(join(root, 'artifacts', 'contrast.json'), `${JSON.stringify(out, null, 2)}\n`);

const md = [];
md.push('# Contrast — designed dark palette');
md.push('');
md.push(`Generated ${out.generatedAt}`);
md.push('');
md.push('## Designed tokens');
md.push('');
md.push('| Token | Hex |');
md.push('|---|---|');
for (const [k, v] of Object.entries(dark)) md.push(`| ${k} | ${v} |`);
md.push('');
md.push(`well darker than bone: ${designed.wellDarkerThanBone} (fill contrast ${designed.wellOnBone}:1 against bone, ${designed.wellOnChalk}:1 against chalk).`);
md.push('');
md.push('The hole is not an AA pairing. Two near-black fills cannot hit 3:1. Distinctness is the well being darker plus the ink/rust edge, which is scored below.');
md.push('');
md.push(`rust chroma ${designed.chroma.rust} > ochre ${designed.chroma.ochre} > moss ${designed.chroma.moss}: ${designed.rustLoudest}`);
md.push('');
md.push('| Pairing | Fg | Bg | Ratio | Need | |');
md.push('|---|---|---|---:|---:|---|');
for (const r of designed.rows) {
  md.push(`| ${r.name} | ${r.fg} | ${r.bg} | ${r.ratio}:1 | ${r.need}:1 | ${r.pass ? 'pass' : 'FAIL'} |`);
}
md.push('');
md.push(`Failed: ${designed.failed.length}`);
md.push('');
md.push('## Invert control');
md.push('');
md.push(`well vs bone ${invertScore.wellOnBone}:1, well darker than bone: ${invertScore.wellDarkerThanBone}`);
md.push('');
md.push(`rust loudest: ${invertScore.rustLoudest} (rust ${invertScore.chroma.rust}, ochre ${invertScore.chroma.ochre}, moss ${invertScore.chroma.moss})`);
md.push('');
md.push(`Failed pairings: ${invertScore.failed.length}`);
for (const r of invertScore.failed) {
  md.push(`- ${r.name} ${r.ratio}:1 need ${r.need}:1`);
}
md.push('');
writeFileSync(join(root, 'artifacts', 'contrast.md'), md.join('\n'));
console.log(md.join('\n'));
if (designed.failed.length) process.exitCode = 1;

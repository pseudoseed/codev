import { chromium } from '/Users/chris/dev/codev-1455/packages/codev/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'arm-b-behavior.json');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto('http://127.0.0.1:4112/b.html', { waitUntil: 'networkidle' });

const selection = await page.evaluate(() => {
  const pre = document.querySelector('#pane-architect pre');
  const range = document.createRange();
  range.selectNodeContents(pre);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const style = getComputedStyle(document.querySelector('#pane-architect .body'));
  return {
    selected: sel.toString().includes('DOM'),
    userSelect: style.userSelect,
    overflow: style.overflow,
    webkitOverflowScrolling: style.webkitOverflowScrolling,
  };
});

await page.click('#pane-architect .close');
const afterClose = await page.evaluate(() => ({
  architectHidden: document.getElementById('pane-architect').hidden,
  builderHidden: document.getElementById('pane-builder').hidden,
  restoreVisible: !document.getElementById('restore-wrap').hidden,
  preStillInDom: !!document.querySelector('#pane-architect pre'),
}));

await page.click('#restore');
const afterRestore = await page.evaluate(() => ({
  architectHidden: document.getElementById('pane-architect').hidden,
  textIntact: document.querySelector('#pane-architect pre').textContent.includes('DOM'),
}));

await page.click('#stack');
const stacked = await page.evaluate(() => document.getElementById('work').classList.contains('stack'));
await page.click('#side');
const sided = await page.evaluate(() => document.getElementById('work').classList.contains('side'));

const report = {
  at: new Date().toISOString(),
  selection,
  afterClose,
  afterRestore,
  stacked,
  sided,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));

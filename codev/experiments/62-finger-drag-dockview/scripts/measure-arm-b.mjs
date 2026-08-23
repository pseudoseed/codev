import { chromium } from '/Users/chris/dev/codev-1455/packages/codev/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'arm-b-targets.json');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1024, height: 768 },
  hasTouch: true,
});
await page.goto('http://127.0.0.1:4112/b.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.tab');
const data = await page.evaluate(() => window.__exp62MeasureB());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
await browser.close();
console.log(JSON.stringify({
  wrote: path.relative(ROOT, OUT),
  fr22: data.fr22,
  firstPair: data.pairs[0],
  safeArea: data.safeArea,
  fontSize: data.fontSize,
}, null, 2));

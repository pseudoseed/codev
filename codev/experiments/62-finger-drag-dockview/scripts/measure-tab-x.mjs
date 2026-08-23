import { chromium } from '/Users/chris/dev/codev-1455/packages/codev/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'tab-x-gap.json');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1024, height: 768 },
  hasTouch: true,
  isMobile: false,
});
await page.goto('http://127.0.0.1:4112/', { waitUntil: 'networkidle' });
await page.waitForSelector('.dv-tab');

const data = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.dv-tab'));
  const rows = tabs.map((tab) => {
    const close = tab.querySelector('.dv-default-tab-action');
    const title = tab.querySelector('.dv-default-tab-content');
    const tr = tab.getBoundingClientRect();
    const cr = close ? close.getBoundingClientRect() : null;
    const yr = title ? title.getBoundingClientRect() : null;
    const contained = cr
      ? cr.left >= tr.left && cr.right <= tr.right && cr.top >= tr.top && cr.bottom <= tr.bottom
      : null;
    const gapTitleToClose = cr && yr ? cr.left - yr.right : null;
    return {
      tabClass: tab.className,
      tab: { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
      close: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
      title: yr ? { x: yr.x, y: yr.y, w: yr.width, h: yr.height } : null,
      closeInsideTab: contained,
      gapTabHitToCloseHitPt: contained ? 0 : null,
      visualGapTitleToClosePx: gapTitleToClose,
    };
  });
  const header = getComputedStyle(document.querySelector('.dv-tabs-and-actions-container'));
  return {
    at: new Date().toISOString(),
    note: 'Chromium 1024x768 against the live spike. Gesture evidence this is not. Geometry of nested hit targets is.',
    viewport: { width: window.innerWidth, height: window.innerHeight, dppx: window.devicePixelRatio },
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    tabBarHeight: header.height,
    rows,
  };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
await browser.close();
console.log(JSON.stringify({ wrote: path.relative(ROOT, OUT), tabs: data.rows.length, first: data.rows[0] }, null, 2));

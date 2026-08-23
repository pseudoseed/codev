import { chromium } from '/Users/chris/dev/codev-1455/packages/codev/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'a-fr22-override.json');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
await page.goto('http://127.0.0.1:4112/a-fr22.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.dv-tab');

const data = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.dv-tab'));
  const closes = Array.from(document.querySelectorAll('.fr22-close'));
  const sashes = Array.from(document.querySelectorAll('.dv-sash'));
  function box(el) {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }
  function gap(a, b) {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return Math.round((rb.left - ra.right) * 10) / 10;
  }
  const pairs = tabs.map((tab) => {
    const close = closes.find((c) => tab.closest('.dv-groupview')?.contains(c));
    return {
      tab: box(tab),
      close: close ? box(close) : null,
      closeInsideTab: close ? tab.contains(close) : null,
      gapTabToClose: close ? gap(tab, close) : null,
    };
  });
  const sashBoxes = sashes.slice(0, 4).map((el) => {
    const b = box(el);
    const before = getComputedStyle(el, '::before');
    return {
      ...b,
      beforeContent: before.content,
      beforeLeft: before.left,
      beforeRight: before.right,
      beforeTop: before.top,
      beforeBottom: before.bottom,
      hitTravel: Math.min(b.w, b.h) + 40,
    };
  });
  return {
    at: new Date().toISOString(),
    pairs,
    sashBoxes,
    tabBarHeight: getComputedStyle(document.querySelector('.dv-tabs-and-actions-container')).height,
  };
});

fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
await browser.close();
console.log(JSON.stringify(data, null, 2));

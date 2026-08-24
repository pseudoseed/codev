import { expect, test, type Page } from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:4173';

async function reset(): Promise<void> {
  await fetch(`${FIXTURE}/__fixture/reset`, { method: 'POST', body: '{}' });
}

async function push(frames: unknown[]): Promise<void> {
  await fetch(`${FIXTURE}/__fixture/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frames }),
  });
}

async function lastEvents(): Promise<{ since: string | null; stream: string | null; mode: string | null }> {
  const res = await fetch(`${FIXTURE}/__fixture/last-events`);
  return res.json() as Promise<{ since: string | null; stream: string | null; mode: string | null }>;
}

async function plantSentinel(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __v2Sentinel?: number }).__v2Sentinel = 1;
  });
}

async function sentinelAlive(page: Page): Promise<number | undefined> {
  return page.evaluate(() => (window as Window & { __v2Sentinel?: number }).__v2Sentinel);
}

async function treeDump(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-kind]')]
      .map((el) =>
        [
          el.getAttribute('data-kind'),
          el.getAttribute('data-id'),
          el.getAttribute('data-dark') ?? '',
          el.className,
        ].join('|'),
      )
      .join('\n'),
  );
}

async function openSite(page: Page): Promise<void> {
  await page.goto('/v2/');
  await expect(page.locator('[data-kind="workspace"]').first()).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async () => {
  await reset();
});

test('load and render hierarchy', async ({ page }) => {
  await openSite(page);
  await expect(page.locator('[data-kind="workspace"]')).toContainText('alpha');
  await expect(page.locator('[data-kind="architect"]')).toContainText('arch');
  await expect(page.locator('[data-kind="builder"][data-id="builder:1"]')).toContainText('b1');
  const header = page.locator('[data-kind="workspace"] .ws-plot-name');
  await expect.poll(async () => header.evaluate((el) => getComputedStyle(el).display)).toBe('flex');
  await expect.poll(async () => header.evaluate((el) => getComputedStyle(el).gap)).toBe('8px');
});

test('new builder appears with no reload', async ({ page }) => {
  await openSite(page);
  const before = await page.evaluate(() => performance.navigation.type);
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:new',
        kind: 'builder',
        parentId: 'workspace:/tmp/alpha',
        name: 'newb',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  await expect(page.locator('[data-kind="builder"][data-id="builder:new"]')).toBeVisible();
  const after = await page.evaluate(() => performance.navigation.type);
  expect(after).toBe(before);
});

test('gate-waiting is GATE rust and rust nowhere else', async ({ page }) => {
  await openSite(page);
  const gate = page.locator('[data-id="builder:2"] .stamp-gate');
  await expect(gate).toHaveText('GATE');
  await expect(page.locator('[data-id="builder:2"]')).toHaveClass(/needs-attn/);
  const rust = 'rgb(181, 80, 42)';
  await expect.poll(async () => gate.evaluate((el) => getComputedStyle(el).color)).toBe(rust);
  const rustHolders = await page.evaluate((want) => {
    return [...document.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return s.color === want || s.backgroundColor === want;
    }).map((el) => el.className);
  }, rust);
  expect(rustHolders.length).toBeGreaterThan(0);
  expect(rustHolders.every((c) => String(c).includes('stamp-gate') || String(c).includes('needs-attn'))).toBe(true);
});

test('stalled is STALLED ochre', async ({ page }) => {
  await openSite(page);
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:1',
        kind: 'builder',
        parentId: 'workspace:/tmp/alpha',
        name: 'b1',
        status: 'stalled',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  const stamp = page.locator('[data-id="builder:1"] .stamp-stalled');
  await expect(stamp).toHaveText('STALLED');
  await expect.poll(async () => stamp.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(192, 138, 46)');
});

// The idle floor. A zero bucket still draws a bar this tall so a quiet
// builder reads as quiet rather than as a broken row (issue #112).
const IDLE = '3px';

test('sparkline advances on tick and silent builder flattens', async ({ page }) => {
  await openSite(page);
  await push([{ type: 'tick', at: 't0', buckets: { 'builder:1': 9, 'builder:2': 9 } }]);
  const busy = page.locator('[data-id="builder:1"] .spark i').last();
  const silent = page.locator('[data-id="builder:2"] .spark i').last();
  await expect.poll(async () => busy.evaluate((el) => (el as HTMLElement).style.height)).not.toBe(IDLE);
  await expect.poll(async () => silent.evaluate((el) => (el as HTMLElement).style.height)).not.toBe(IDLE);
  await push([{ type: 'tick', at: 't1', buckets: { 'builder:1': 9 } }]);
  await expect.poll(async () => silent.evaluate((el) => (el as HTMLElement).style.height)).toBe(IDLE);
});

test('an all-zero trace is a flat baseline with real height', async ({ page }) => {
  await openSite(page);
  const bars = page.locator('[data-id="builder:2"] .spark i');
  await expect(bars).toHaveCount(20);
  const boxes = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(boxes.every((h) => h >= 3)).toBe(true);
  expect(new Set(boxes).size).toBe(1);
});

test('every node kind carries its prefix in the browser', async ({ page }) => {
  await openSite(page);
  await expect(page.locator('[data-kind="workspace"] .kind-prefix').first()).toHaveText('workspace /');
  await expect(page.locator('[data-kind="architect"] .kind-prefix').first()).toHaveText('architect/');
  await expect(page.locator('[data-id="builder:1"] .kind-prefix')).toHaveText('builder/');
  await expect(page.locator('[data-id="builder:1"] .stake-name')).toHaveText('builder/b1');
  await expect(page.getByTestId('site-register')).toContainText('22 workspaces');
  await expect(page.getByTestId('site-register')).toContainText('58 builders');
});

test('plots size to their content instead of the tallest in the row', async ({ page }) => {
  // Issue #111. The tall workspace must not pad the short one beside it.
  await openSite(page);
  await push([
    {
      type: 'node',
      node: {
        id: 'workspace:/tmp/beta',
        kind: 'workspace',
        parentId: null,
        name: 'beta',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  const grid = page.locator('.plot-grid');
  await expect.poll(async () => grid.evaluate((el) => getComputedStyle(el).alignItems)).toBe('start');
  await expect(page.locator('[data-id="workspace:/tmp/beta"]')).toBeVisible();
  const heights = await page
    .locator('.plot-grid > [data-kind="workspace"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBe(2);
  expect(Math.min(...heights)).toBeLessThan(Math.max(...heights));
});

test('gone removes the row', async ({ page }) => {
  await openSite(page);
  await push([{ type: 'gone', id: 'builder:2' }]);
  await expect(page.locator('[data-id="builder:2"]')).toHaveCount(0);
});

test('disconnect then honoured resume recovers without reload', async ({ page }) => {
  await openSite(page);
  await plantSentinel(page);
  await fetch(`${FIXTURE}/__fixture/honor-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ honor: true }),
  });
  await fetch(`${FIXTURE}/__fixture/disconnect`, { method: 'POST', body: '{}' });
  await expect.poll(async () => (await lastEvents()).mode).toBe('resumed');
  const honoured = await lastEvents();
  expect(honoured.since).not.toBeNull();
  expect(honoured.stream).toBe('s1');
  await expect(page.locator('[data-id="builder:1"]')).toBeVisible();
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:resume',
        kind: 'builder',
        parentId: 'workspace:/tmp/alpha',
        name: 'resumed',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  await expect(page.locator('[data-id="builder:resume"]')).toBeVisible();
  await expect(page.locator('[data-id="builder:1"]')).toBeVisible();
  expect(await sentinelAlive(page)).toBe(1);
});

test('disconnect then refused snapshot recovers without reload', async ({ page }) => {
  await openSite(page);
  await plantSentinel(page);
  await fetch(`${FIXTURE}/__fixture/honor-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ honor: false, streamId: 's2' }),
  });
  await fetch(`${FIXTURE}/__fixture/disconnect`, { method: 'POST', body: '{}' });
  await expect.poll(async () => (await lastEvents()).since).not.toBeNull();
  const refused = await lastEvents();
  expect(refused.mode).toBe('snapshot');
  expect(refused.stream).toBe('s1');
  await expect(page.locator('[data-id="builder:1"]')).toBeVisible();
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:refused',
        kind: 'builder',
        parentId: 'workspace:/tmp/alpha',
        name: 'refused',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  await expect(page.locator('[data-id="builder:refused"]')).toBeVisible();
  await expect(page.locator('[data-id="builder:1"]')).toBeVisible();
  expect(await sentinelAlive(page)).toBe(1);
});

test('dark workspace dark, sibling live', async ({ page }) => {
  await openSite(page);
  await push([{ type: 'dark', id: 'workspace:/tmp/gone', reason: 'unreadable' }]);
  await expect(page.locator('[data-dark="true"]')).toContainText('gone');
  await expect(page.locator('[data-id="workspace:/tmp/alpha"]')).not.toHaveClass(/dim-sub/);
});

test('unreachable and zero workspaces differ', async ({ page }) => {
  await fetch(`${FIXTURE}/__fixture/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { workspaces: [] } }),
  });
  await page.goto('/v2/');
  await expect(page.getByTestId('empty-site')).toBeVisible();
  await expect(page.getByTestId('unreachable')).toHaveCount(0);

  await reset();
  await fetch(`${FIXTURE}/__fixture/unreachable`, { method: 'POST', body: '{}' });
  await page.goto('/v2/');
  await expect(page.getByTestId('unreachable')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('empty-site')).toHaveCount(0);
});

test('two pages on one scope converge', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await a.goto('/v2/');
  await b.goto('/v2/');
  await expect(a.locator('[data-kind="builder"][data-id="builder:1"]')).toBeVisible();
  await expect(b.locator('[data-kind="builder"][data-id="builder:1"]')).toBeVisible();
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:z',
        kind: 'builder',
        parentId: 'workspace:/tmp/alpha',
        name: 'bz',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  await expect(a.locator('[data-id="builder:z"]')).toBeVisible();
  await expect(b.locator('[data-id="builder:z"]')).toBeVisible();
  expect(await treeDump(a)).toBe(await treeDump(b));
  await ctx.close();
});

test('counts sit in the footer as machine totals', async ({ page }) => {
  await openSite(page);
  const foot = page.getByTestId('machine-totals');
  await expect(foot).toContainText('Machine totals');
  await expect(foot).toContainText('22 workspaces');
  await expect(foot).toContainText('58 builders');
});

test('builder sits under workspace beside architect', async ({ page }) => {
  await openSite(page);
  const ws = page.locator('[data-kind="workspace"]');
  await expect(ws.locator('[data-kind="architect"]')).toHaveCount(1);
  await expect(ws.locator('[data-kind="builder"]')).toHaveCount(2);
  await expect(ws.locator('[data-kind="architect"] [data-kind="builder"]')).toHaveCount(0);
});

test('architect-parented builder nests under that architect', async ({ page }) => {
  await openSite(page);
  await push([
    {
      type: 'node',
      node: {
        id: 'builder:nested',
        kind: 'builder',
        parentId: 'architect:1',
        name: 'nested',
        status: 'running',
        flags: { heldMail: false },
        lastDataAt: null,
      },
    },
  ]);
  const arch = page.locator('[data-kind="architect"][data-id="architect:1"]');
  await expect(arch.locator('[data-id="builder:nested"]')).toBeVisible();
  await expect(page.locator('[data-kind="workspace"] > .stake-list [data-id="builder:nested"]')).toHaveCount(0);
});

test('cold load and idle bandwidth are measured', async ({ page }) => {
  const start = Date.now();
  await openSite(page);
  const ms = Date.now() - start;
  const loadBytes = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries.reduce((n, e) => n + (e.transferSize || 0), 0);
  });
  const t0 = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).reduce((n, e) => n + (e.transferSize || 0), 0),
  );
  await page.waitForTimeout(1000);
  const t1 = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).reduce((n, e) => n + (e.transferSize || 0), 0),
  );
  console.log(`cold-load-ms=${ms} load-bytes=${loadBytes} idle-Bps=${t1 - t0}`);
});

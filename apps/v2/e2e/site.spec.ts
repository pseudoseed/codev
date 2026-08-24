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
  const rustHolders = await page.evaluate(() => {
    const rust = 'rgb(181, 80, 42)';
    return [...document.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return s.color === rust || s.backgroundColor === rust;
    }).map((el) => el.className);
  });
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
  await expect(page.locator('[data-id="builder:1"] .stamp-stalled')).toHaveText('STALLED');
});

test('sparkline advances on tick and silent builder flattens', async ({ page }) => {
  await openSite(page);
  await push([{ type: 'tick', at: 't0', buckets: { 'builder:1': 9, 'builder:2': 9 } }]);
  const busy = page.locator('[data-id="builder:1"] .spark i').last();
  const silent = page.locator('[data-id="builder:2"] .spark i').last();
  await expect.poll(async () => busy.evaluate((el) => (el as HTMLElement).style.height)).not.toBe('2px');
  await expect.poll(async () => silent.evaluate((el) => (el as HTMLElement).style.height)).not.toBe('2px');
  await push([{ type: 'tick', at: 't1', buckets: { 'builder:1': 9 } }]);
  await expect.poll(async () => silent.evaluate((el) => (el as HTMLElement).style.height)).toBe('2px');
});

test('gone removes the row', async ({ page }) => {
  await openSite(page);
  await push([{ type: 'gone', id: 'builder:2' }]);
  await expect(page.locator('[data-id="builder:2"]')).toHaveCount(0);
});

test('disconnect then honoured resume recovers without reload', async ({ page }) => {
  await openSite(page);
  await fetch(`${FIXTURE}/__fixture/honor-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ honor: true }),
  });
  await fetch(`${FIXTURE}/__fixture/disconnect`, { method: 'POST', body: '{}' });
  await page.waitForTimeout(1500);
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
});

test('disconnect then refused snapshot recovers without reload', async ({ page }) => {
  await openSite(page);
  await fetch(`${FIXTURE}/__fixture/honor-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ honor: false, streamId: 's2' }),
  });
  await fetch(`${FIXTURE}/__fixture/disconnect`, { method: 'POST', body: '{}' });
  await page.waitForTimeout(1500);
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

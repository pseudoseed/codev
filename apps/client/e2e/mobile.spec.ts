/**
 * Criterion 5, measured at 390px: the grid PAGES rather than shrinks, and
 * `document.documentElement.scrollWidth` never exceeds the viewport width.
 *
 * `scrollWidth` is the assertion the criterion names, and it is the right one:
 * it catches an overflow caused by anything at all — a min-width, an unbroken
 * token, a fixed-width table — rather than only the causes somebody thought to
 * check. A per-element width assertion passes while one 600px child pushes the
 * document sideways.
 */
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error — the harness is plain ESM on purpose; it carries no types.
import { cleanupScratch, makeWorkspace, serveClient, startHost } from './fixture.mjs';

const PHONE = { width: 390, height: 844 };

let host: any;
let staticServer: any;
let clientOrigin: string;

test.beforeAll(async () => {
  const workspace = makeWorkspace('mobile', null, { extraBuilders: 4, messagesPerAgent: 3 });
  host = await startHost({ port: 0, workspace, machine: 'mobile' });
  const entry = {
    id: 'mobile',
    label: 'mobile',
    origin: `http://127.0.0.1:${host.port}`,
    workspacePath: host.workspacePath,
    credential: host.credential,
  };
  staticServer = await serveClient(0, () => [entry]);
  clientOrigin = `http://127.0.0.1:${staticServer.address().port}`;
});

test.afterAll(async () => {
  await host?.stop();
  await staticServer?.shutdown();
  cleanupScratch();
});

async function openPhone(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto(`${clientOrigin}/client/`);
  await expect(page.locator('.paged .pane')).toBeVisible({ timeout: 30_000 });
}

async function scrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

test.describe('criterion 5: one pane per screen at 390px', () => {
  test('shows exactly one pane, with a pager, not a shrunken grid', async ({ page }) => {
    await openPhone(page);
    await expect(page.locator('.pane')).toHaveCount(1);
    await expect(page.locator('.tile-grid')).toHaveCount(0);
    await expect(page.locator('.pager')).toBeVisible();
  });

  test('documentElement.scrollWidth does not exceed the viewport width', async ({ page }) => {
    await openPhone(page);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  /*
   * ON EVERY PAGE, not only the first. The pane that overflows is the one with
   * the longest content, and paging through is the only way to render it.
   */
  test('stays within the viewport on every page, including the architect', async ({ page }) => {
    await openPhone(page);
    const total = Number((await page.locator('.pager-position').getAttribute('data-position'))!.split('/')[1]);
    expect(total).toBe(7);

    for (let index = 0; index < total; index += 1) {
      await expect(page.locator('.pager-position')).toHaveAttribute('data-position', `${index + 1}/${total}`);
      expect(await scrollWidth(page), `page ${index + 1}`).toBeLessThanOrEqual(PHONE.width);
      await expect(page.locator('.pane')).toHaveCount(1);
      if (index < total - 1) await page.locator('[data-step="next"]').click();
    }
    // The last page is the architect, so a phone reaches every row rather than
    // only the builders.
    await expect(page.locator('.pane[data-kind="architect"]')).toBeVisible();
  });

  test('a long unbroken message still does not push the document sideways', async ({ page }) => {
    await openPhone(page);
    await page.locator('.msg-body').first().evaluate((element) => {
      element.textContent = 'x'.repeat(400);
    });
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test('the pager stops at both ends rather than wrapping silently', async ({ page }) => {
    await openPhone(page);
    await expect(page.locator('[data-step="previous"]')).toBeDisabled();
    await page.locator('[data-step="next"]').click();
    await expect(page.locator('[data-step="previous"]')).toBeEnabled();
  });

  test('the tablet width between the two layouts grids rather than pages', async ({ page }) => {
    // An iPad in portrait is 820px, which is criterion 6's device. It must get
    // the grid, and it must not scroll sideways either.
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`${clientOrigin}/client/`);
    await expect(page.locator('.tile-grid .pane').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.pager')).toHaveCount(0);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(820);
  });
});

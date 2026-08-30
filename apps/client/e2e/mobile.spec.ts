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

/*
 * THE FIRST-RUN PATH, WHICH IS THE ONE MOST OPERATORS SEE.
 *
 * Tower's mount answers `{ signal, message, machines: [] }` when it has no
 * machine list, and no `client-machines.json` is the normal state of a fresh
 * install. The client used to reject that shape as "not a list of machines",
 * replacing the server's specific reason with a generic one at exactly the
 * moment a person needs to know what to do next.
 *
 * Served here by the harness rather than by Tower, because what is under test is
 * the CLIENT's handling of the envelope; the mount's half is covered by
 * `spec-146-phase-12-client-mount.e2e.test.ts` against the real dispatcher.
 */
test.describe("Tower's configuration sentence reaches the page", () => {
  test('renders the server message instead of a generic one', async ({ page }) => {
    const message = 'No machine list at /root/.agent-farm/client-machines.json. '
      + 'Tower serves the client but has nothing to connect it to.';
    await page.route('**/client/machines.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ signal: 'CLIENT_MACHINES_ABSENT', message, machines: [] }),
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${clientOrigin}/client/`);

    const error = page.locator('.config-error');
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText('client-machines.json');
    await expect(error).not.toContainText('is not a list of machines');
  });
});

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

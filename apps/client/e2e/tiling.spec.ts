/**
 * Criteria 4 and 4b, MEASURED FROM THE RENDERED PAGE.
 *
 * Every number here is read back out of the browser — `getBoundingClientRect`
 * for geometry, `getComputedStyle` for type — rather than asserted against the
 * stylesheet that was supposed to produce it. The plan says so explicitly, and
 * #112 is the reason: a client passed 127 component tests, 3,394 server tests
 * and 15/15 Playwright while being unusable, because everything that was checked
 * was checked against what the code intended rather than against what a person
 * would see.
 *
 * The viewport is set per test rather than in `playwright.config.ts`, because
 * the criteria ARE viewport-specific: 1440x900 and 1920x1080 make different
 * claims, and a shared default would silently satisfy neither.
 */
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error — the harness is plain ESM on purpose; it carries no types.
import { cleanupScratch, makeWorkspace, serveClient, startHost } from './fixture.mjs';

const MIN_PANE_W = 340;
const MIN_PANE_H = 240;
const MIN_BODY_PX = 13;

let host: any;
let staticServer: any;
let clientOrigin: string;

test.beforeAll(async () => {
  // Six builders exactly, because six is the count criterion 4 names.
  const workspace = makeWorkspace('tiling', null, { extraBuilders: 4, messagesPerAgent: 4 });
  host = await startHost({ port: 0, workspace, machine: 'tiling' });
  const entry = {
    id: 'tiling',
    label: 'tiling',
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

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${clientOrigin}/client/`);
  await expect(page.locator('.tile-grid .pane').first()).toBeVisible({ timeout: 30_000 });
}

/** The measurements, taken in the page. */
async function paneBoxes(page: Page): Promise<Array<{ width: number; height: number }>> {
  return page.locator('.tile-grid .pane').evaluateAll((panes) =>
    panes.map((pane) => {
      const box = pane.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }));
}

test.describe('criterion 4: six builders tile 3x2 at 1440x900', () => {
  test('six panes, three columns, two rows', async ({ page }) => {
    await open(page, 1440, 900);
    await expect(page.locator('.tile-grid .pane')).toHaveCount(6);

    // The ROW/COLUMN structure from geometry, not from the CSS declaration:
    // distinct left offsets are columns, distinct top offsets are rows.
    const offsets = await page.locator('.tile-grid .pane').evaluateAll((panes) => ({
      lefts: [...new Set(panes.map((pane) => Math.round(pane.getBoundingClientRect().left)))],
      tops: [...new Set(panes.map((pane) => Math.round(pane.getBoundingClientRect().top)))],
    }));
    expect(offsets.lefts).toHaveLength(3);
    expect(offsets.tops).toHaveLength(2);
  });

  test('every pane is at least 340x240 CSS px', async ({ page }) => {
    await open(page, 1440, 900);
    const boxes = await paneBoxes(page);
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(MIN_PANE_W);
      expect(box.height).toBeGreaterThanOrEqual(MIN_PANE_H);
    }
  });

  test('body text computes to 13px or larger', async ({ page }) => {
    await open(page, 1440, 900);
    /*
     * The elements that carry MEANING, named rather than "every element": the
     * uppercase micro-labels are chrome and are deliberately smaller. Asserting
     * on all descendants would either fail on chrome or force the chrome up to
     * 13px, and neither is what the criterion asks for.
     */
    const sizes = await page.locator('.tile-grid .pane').first().evaluate((pane) => {
      const read = (selector: string) => {
        const element = pane.querySelector(selector);
        return element ? parseFloat(getComputedStyle(element).fontSize) : null;
      };
      return {
        pane: parseFloat(getComputedStyle(pane).fontSize),
        name: read('.pane-name'),
        status: read('.status-stamp'),
        message: read('.msg-body'),
      };
    });
    for (const [what, size] of Object.entries(sizes)) {
      expect(size, `${what} font size`).not.toBeNull();
      expect(size!, `${what} font size`).toBeGreaterThanOrEqual(MIN_BODY_PX);
    }
  });

  test('each pane shows its builder id, its status and its last three messages', async ({ page }) => {
    await open(page, 1440, 900);
    const panes = page.locator('.tile-grid .pane');
    for (let index = 0; index < 6; index += 1) {
      const pane = panes.nth(index);
      // The id, WITH the kind prefix — the thing #112 dropped.
      await expect(pane.locator('.kind-prefix')).toHaveText('builder/');
      await expect(pane.locator('.pane-name')).not.toHaveText('builder/');
      // The status as a word, never a bare mark.
      await expect(pane.locator('.status-stamp')).not.toHaveText('');
      // Three messages, newest first — seeded four, so a fourth would be a bug.
      await expect(pane.locator('.msg-body')).toHaveCount(3);
    }
    const bodies = await panes.first().locator('.msg-body').allTextContents();
    expect(bodies[0]).toContain('message 4');
    expect(bodies[2]).toContain('message 2');
  });

  test('no pane is clipped out of the viewport', async ({ page }) => {
    await open(page, 1440, 900);
    const overflowing = await page.locator('.tile-grid .pane').evaluateAll((panes) =>
      panes.filter((pane) => pane.getBoundingClientRect().right > window.innerWidth).length);
    expect(overflowing).toBe(0);
  });
});

test.describe('criterion 4b: the architect is not a seventh tile at 1440', () => {
  test('six tiles and a strip, not seven tiles', async ({ page }) => {
    await open(page, 1440, 900);
    await expect(page.locator('.tile-grid .pane')).toHaveCount(6);
    await expect(page.locator('.tile-grid [data-kind="architect"]')).toHaveCount(0);
    await expect(page.locator('.architect-strip')).toBeVisible();
  });

  test('the strip shows the architect status and its last message', async ({ page }) => {
    await open(page, 1440, 900);
    const strip = page.locator('.architect-strip');
    await expect(strip.locator('.status-stamp')).not.toHaveText('');
    await expect(strip.locator('.strip-detail')).toContainText('main message 4');
  });

  test('expanding replaces the grid, and going back restores it', async ({ page }) => {
    await open(page, 1440, 900);
    await page.locator('.architect-strip .strip-expand').click();

    await expect(page.locator('[data-layout="expanded"]')).toBeVisible();
    await expect(page.locator('.tile-grid')).toHaveCount(0);
    await expect(page.locator('.pane[data-kind="architect"]')).toBeVisible();

    await page.locator('[data-layout="expanded"] .strip-expand').first().click();
    await expect(page.locator('.tile-grid .pane')).toHaveCount(6);
  });

  test('a seventh equal tile appears at 1920, and the strip goes away', async ({ page }) => {
    await open(page, 1920, 1080);
    await expect(page.locator('.tile-grid .pane')).toHaveCount(7);
    await expect(page.locator('.tile-grid [data-kind="architect"]')).toHaveCount(1);
    await expect(page.locator('.architect-strip')).toHaveCount(0);

    // "EQUAL" is the load-bearing word: a seventh tile that is half the size of
    // the others is not what the criterion offers.
    const boxes = await paneBoxes(page);
    const widths = [...new Set(boxes.map((box) => Math.round(box.width)))];
    expect(widths).toHaveLength(1);
    expect(widths[0]).toBeGreaterThanOrEqual(MIN_PANE_W);
  });
});

/**
 * Spec 250, phase 9 — the tiling, measured from the rendered page.
 *
 * ## Why this cannot be a unit test
 *
 * `layout.test.ts` proves the arithmetic: seven panes in 1664px of content get
 * four columns. It cannot prove the pane a browser actually draws is 340px wide
 * INSIDE t3code's chrome, because the number that decides it — the grid
 * container's width behind a 232px sidebar — is not a number any unit test has.
 * That is why criteria 5 and 5b say "measured from the rendered page", and it is
 * why the constants were re-measured rather than ported: `apps/client` owned the
 * whole viewport and this grid does not.
 *
 * ## Criterion 5b is the one that matters
 *
 * Both the fewest-rows rule and the near-square rule give three columns for six
 * panes at 1440, so criterion 5 alone cannot tell them apart. Seven panes at
 * 1920 can: fewest-rows gives 4x2, near-square gives 3x3. The fixture seeds
 * exactly seven for that reason.
 *
 * Running it: see `spec-250-hierarchy.spec.ts` — same stack, same commands.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  forkScreenshotPath,
  mintPairingCredential,
  seedTiling,
  startForkStack,
  stopForkStack,
  type ForkStackReady,
  type SeededTiling,
} from "./spec-250-fork-stack";

let stack: ForkStackReady | null = null;
let seeded: SeededTiling | null = null;
let unavailable: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const started = await startForkStack();
  if (!started.available) {
    unavailable = started.reason;
    return;
  }
  stack = started;
  seeded = await seedTiling(started);
});

test.afterAll(() => {
  if (stack !== null) stopForkStack();
});

test.beforeEach(() => {
  test.skip(unavailable !== null, unavailable ?? "");
});

/** Criterion 5's floors, restated here so the spec does not import the fork. */
const MIN_PANE_W = 340;
const MIN_PANE_H = 240;
const MIN_BODY_PX = 13;

function ready(): { stack: ForkStackReady; seeded: SeededTiling } {
  if (stack === null || seeded === null) {
    throw new Error("unreachable: the fork stack is checked before this runs");
  }
  return { stack, seeded };
}

/** Pair a fresh context and land on the builder grid. */
async function openGrid(page: Page): Promise<void> {
  const { stack: live } = ready();
  const credential = await mintPairingCredential(live);
  await page.goto(`${live.webUrl}/pair#token=${credential}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Enter a pairing token to start a session"),
    "the browser did not pair; every measurement below would be of the pairing form",
  ).toHaveCount(0, { timeout: 30_000 });
  /*
   * Through the sidebar link, not by typing the URL.
   *
   * Review finding: the route existed and nothing linked to it. A test that
   * `goto`s the path proves the route renders and says nothing about whether a
   * user can find it — which is how the grid shipped unreachable.
   */
  const link = page.getByTestId("sidebar-codev-builders-link");
  const toggle = page.getByRole("button", { name: /toggle (main )?sidebar/i }).first();
  let openedSidebar = false;
  try {
    await link.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    // At 390 the sidebar is off-canvas, so the way in is behind the toggle —
    // which is still a way in, and the assertion is that one exists.
    if ((await toggle.count()) > 0) {
      await toggle.click();
      openedSidebar = true;
    }
    await link.waitFor({ state: "visible", timeout: 20_000 });
  }
  // t3code's provider-update toast lands over the sidebar at 390 and intercepts
  // the click. Dismissed the way a user dismisses it, rather than forced.
  const dismissals = page.getByRole("button", { name: /dismiss notification/i });
  for (let index = await dismissals.count(); index > 0; index -= 1) {
    await dismissals.first().click();
  }
  await link.click();
  // On a phone the drawer stays open over the page it just navigated to, so
  // close it again — which is what a user does, and what puts the grid on
  // screen to be measured.
  if (openedSidebar) await toggle.click();
  await expect(page.getByTestId("codev-builder-pane").first()).toBeVisible({ timeout: 30_000 });
}

function panes(page: Page): Locator {
  return page.getByTestId("codev-builder-pane");
}

/**
 * The distinct column positions the browser actually laid out.
 *
 * The grid also reports its column count in `data-codev-grid-columns`, and an
 * assertion on that attribute alone would be asking the component to confirm its
 * own arithmetic. Counting distinct x-positions of the rendered boxes asks the
 * BROWSER. Both are checked, and they have to agree.
 */
async function renderedColumns(page: Page): Promise<number> {
  const boxes = await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().x)),
  );
  return new Set(boxes).size;
}

/** Criterion 5. */
test("six builders are watchable at 1440x900, every pane over the floor", async ({ page }) => {
  const { seeded: fixture } = ready();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page);

  // SIX panes at 1440, not seven — criterion 4b. Three columns and seven items
  // is 3 + 3 + 1: one lonely card beside two empty slots. The architect is on a
  // strip below the grid instead.
  await expect(panes(page)).toHaveCount(6);
  for (const title of fixture.builderTitles) {
    await expect(panes(page).filter({ hasText: title })).toHaveCount(1);
  }
  await expect(page.getByTestId("codev-architect-strip")).toHaveCount(1);
  await expect(page.getByTestId("codev-architect-strip")).toContainText(fixture.architectTitle);
  await expect(page.getByTestId("codev-builder-grid")).toHaveAttribute(
    "data-codev-architect-placement",
    "strip",
  );

  const boxes = await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }),
  );
  expect(boxes).toHaveLength(6);
  for (const box of boxes) {
    expect(box.width, "a pane fell under the 340px floor").toBeGreaterThanOrEqual(MIN_PANE_W);
    expect(box.height, "a pane fell under the 240px floor").toBeGreaterThanOrEqual(MIN_PANE_H);
  }

  // Three columns at 1440 — the count both rules agree on, asserted so a
  // regression that broke BOTH of them is caught here rather than only at 1920.
  // Six panes in three columns is a clean 3x2, which is the shape 4b protects.
  expect(await renderedColumns(page)).toBe(3);
  const rows = await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().y)),
  );
  expect(new Set(rows).size).toBe(2);
  await expect(page.getByTestId("codev-builder-grid")).toHaveAttribute(
    "data-codev-grid-columns",
    "3",
  );

  // Body text. Every text node a human reads in a pane, not one sampled line.
  const sizes = await panes(page)
    .locator("p, span, div")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => (node.textContent ?? "").trim().length > 0)
        .map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    );
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) {
    expect(size).toBeGreaterThanOrEqual(MIN_BODY_PX);
  }
});

/**
 * The role prefix is the pane's only structural signal of what it is.
 *
 * The sidebar can fall back on indent and a rail; a grid of equal tiles cannot,
 * and the case that needs it most is several architects taking tiles beside the
 * builders rather than one taking a strip. So the prefix must survive the
 * NARROWEST pane, which is the pane at the 340px floor — the sidebar's own role
 * caption truncates to "Archit…" under exactly that pressure.
 */
test("every pane names its role in full, even at the narrowest width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page);

  const roles = page.getByTestId("codev-pane-role");
  await expect(roles).toHaveCount(6);

  // Not truncated: an element whose content is wider than its box is one the
  // browser is clipping, and `text-overflow: ellipsis` makes that invisible to
  // a text assertion — `toContainText("builder/")` passes on "buil…" because the
  // DOM still holds the whole string.
  const clipped = await roles.evaluateAll((nodes) =>
    nodes
      .map((node) => ({ text: node.textContent ?? "", over: node.scrollWidth - node.clientWidth }))
      .filter((entry) => entry.over > 0),
  );
  expect(clipped, "a pane's role prefix was clipped").toEqual([]);

  for (const text of await roles.allInnerTexts()) {
    expect(text.trim()).toBe("builder/");
  }

  // And the expanded architect, which is the same pane component and the one
  // whose prefix is doing the most work.
  await page.getByTestId("codev-architect-strip-toggle").click();
  const architectRole = page
    .getByTestId("codev-architect-strip")
    .getByTestId("codev-pane-role");
  await expect(architectRole).toHaveText("architect/");
  expect(
    await architectRole.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(0);
});

/**
 * CRITERION 5b. The case criterion 5 cannot see.
 *
 * Fewest-rows: 4x2. Near-square: 3x3 — three columns of a five-column-wide
 * screen, with a last row holding one tile beside two tiles' worth of nothing.
 */
test("seven panes at 1920 tile 4x2, not 3x3", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGrid(page);
  // Seven here, because four columns fit and 4 + 3 is not ragged — criterion 4b
  // offers the architect an equal tile exactly where that is true.
  await expect(panes(page)).toHaveCount(7);
  await expect(page.getByTestId("codev-architect-strip")).toHaveCount(0);
  await expect(page.getByTestId("codev-builder-grid")).toHaveAttribute(
    "data-codev-architect-placement",
    "tile",
  );

  expect(await renderedColumns(page), "seven panes did not lay out in four columns").toBe(4);
  await expect(page.getByTestId("codev-builder-grid")).toHaveAttribute(
    "data-codev-grid-columns",
    "4",
  );

  // Two rows, said as its own claim: four columns and three rows is not a thing
  // seven panes can do, but asserting it means a future rule that produced one
  // fails here loudly rather than passing the column check by accident.
  const rows = await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().y)),
  );
  expect(new Set(rows).size).toBe(2);

  for (const box of await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().width),
  )) {
    expect(box).toBeGreaterThanOrEqual(MIN_PANE_W);
  }
});

/** The 390px claim: page, do not shrink, and do not widen the document. */
test("the grid pages at 390 and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGrid(page);

  const grid = page.getByTestId("codev-builder-grid");
  await expect(grid).toHaveAttribute("data-codev-grid-mode", "paged");
  await expect(grid).toHaveAttribute("data-codev-grid-columns", "1");

  // Paged, not shrunk: the panes on screen are a page of them, and the rest are
  // behind the pager rather than squeezed in beside these.
  // Six builders on a paged grid: three pages of two, with the architect on its
  // strip below rather than taking a page slot of its own.
  await expect(panes(page)).toHaveCount(2);
  await expect(page.getByTestId("codev-architect-strip")).toHaveCount(1);
  await expect(page.getByTestId("codev-builder-grid-page-label")).toContainText("Page 1 of 3");

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `the document is ${overflow.scrollWidth - overflow.clientWidth}px wider than the viewport`,
  ).toBe(overflow.clientWidth);

  // And the pager works, which is the difference between paging and hiding.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("codev-builder-grid-page-label")).toContainText("Page 2 of 3");
  await expect(panes(page)).toHaveCount(2);
});

/**
 * Criterion 4b's other half: the strip is not a demotion, it expands.
 *
 * "It gets a persistent strip below the grid showing status, and expands to a
 * full pane on demand." A strip that could not expand would be hiding the
 * architect rather than placing it.
 */
test("the architect strip expands to a full pane and back", async ({ page }) => {
  const { seeded: fixture } = ready();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page);

  const strip = page.getByTestId("codev-architect-strip");
  await expect(strip).toHaveAttribute("data-codev-architect-expanded", "false");
  // Collapsed, it is a line: status and identity, no pane.
  await expect(strip.getByTestId("codev-builder-pane")).toHaveCount(0);
  await expect(strip).toContainText(fixture.architectTitle);

  await page.getByTestId("codev-architect-strip-toggle").click();
  await expect(strip).toHaveAttribute("data-codev-architect-expanded", "true");
  await expect(strip.getByTestId("codev-builder-pane")).toHaveCount(1);
  // And the builders keep their grid — expanding the architect is not a mode
  // that takes the screen away from what it was watching.
  await expect(panes(page)).toHaveCount(7);
  expect(await renderedColumns(page)).toBe(3);

  await page.getByTestId("codev-architect-strip-toggle").click();
  await expect(strip).toHaveAttribute("data-codev-architect-expanded", "false");
  await expect(panes(page)).toHaveCount(6);
});

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`the grid at ${viewport.name}: screenshotted and free of console errors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openGrid(page);

    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(panes(page).first()).toBeVisible({ timeout: 30_000 });

    const dismissals = page.getByRole("button", { name: /dismiss notification/i });
    for (let index = await dismissals.count(); index > 0; index -= 1) {
      await dismissals.first().click();
    }
    await page.waitForTimeout(700);
    await page.screenshot({ path: forkScreenshotPath("phase-9", viewport.name), fullPage: true });

    expect(consoleErrors, `console errors at ${viewport.name}`).toEqual([]);
  });
}

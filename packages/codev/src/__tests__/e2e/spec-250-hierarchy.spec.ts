/**
 * Spec 250, phase 7 — the three-level tree, in t3code's own web app.
 *
 * ## Why this exists when `hierarchy.test.ts` already passes
 *
 * Those tests are about the grouping, and they are complete about it. They can
 * say nothing about whether a browser draws what they returned. Every finding on
 * this project so far has come from the same shape of gap — a layer testing its
 * own output while the layer above it discarded the part that mattered — and
 * "the sidebar renders a tree" is the last claim with no measurement under it.
 *
 * So this drives the FORK's web app against the FORK's server. Not a component
 * harness: a component test supplies the shells itself, which is precisely the
 * step whose absence is the risk. The threads here are created over the wire and
 * arrive by subscription, the way they do for a user.
 *
 * ## Running it
 *
 *   1. Start the fork's web app, from the fork checkout's `apps/web`:
 *        T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_PORT=3811 PORT=5733 npx vp dev
 *   2. Then, from this repository:
 *        export T3_NODE=/opt/homebrew/Cellar/node/26.4.0/bin/node
 *        export T3CODE_FORK_ROOT=/Users/chris/dev/t3code-codev T3_HARNESS_PORT=3811
 *        npx playwright test --config playwright.spec250.config.ts
 *
 * The fork SERVER is started by the fixture, on an empty data directory, because
 * the order assertions are meaningless over accumulated data. The WEB APP is not:
 * an absent one is reported as a skip with the command to start it, never as a
 * pass. "I could not tell" and "there is no tree" must not be spelled the same.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  forkScreenshotPath,
  mintPairingCredential,
  seedHierarchy,
  startForkStack,
  stopForkStack,
  type ForkStackReady,
  type SeededHierarchy,
} from "./spec-250-fork-stack";

let stack: ForkStackReady | null = null;
let seeded: SeededHierarchy | null = null;
let unavailable: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const started = await startForkStack();
  if (!started.available) {
    unavailable = started.reason;
    return;
  }
  stack = started;
  seeded = await seedHierarchy(started);
});

test.afterAll(() => {
  if (stack !== null) stopForkStack();
});

/**
 * Open the sidebar, paired, on a browser context that has never been paired.
 *
 * A fresh credential per call: the server consumes them, and a second page
 * opened on a spent one lands on the pairing FORM — which looks like an empty
 * sidebar and is not one.
 */
async function openSidebar(page: Page): Promise<void> {
  const ready = stack;
  if (ready === null) throw new Error("unreachable: the fork stack is checked before this runs");
  const credential = await mintPairingCredential(ready);
  await page.goto(`${ready.webUrl}/pair#token=${credential}`, { waitUntil: "domcontentloaded" });
  // The pairing form means the credential did not take. Say so here rather than
  // letting every assertion below fail as "no tree".
  await expect(
    page.getByText("Enter a pairing token to start a session"),
    "the browser did not pair; the sidebar assertions below would all be about the pairing form",
  ).toHaveCount(0, { timeout: 30_000 });
  await revealSidebar(page);
  await expect(page.getByTestId("sidebar-codev-architect").first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Open the sidebar if this viewport keeps it off-canvas.
 *
 * At 390px t3code hides the sidebar behind a toggle, which is its own decision
 * and not something this customization should override. A test that asserted
 * against a closed sidebar would report "no tree" for a tree that is simply not
 * on screen yet — the difference between a layout bug and a layout.
 */
async function revealSidebar(page: Page): Promise<void> {
  const tree = page.getByTestId("sidebar-codev-architect").first();
  try {
    await tree.waitFor({ state: "visible", timeout: 5_000 });
    return;
  } catch {
    // Closed, or not rendered at all. The toggle distinguishes them.
  }
  // "Toggle main sidebar" on the chat layout, "Toggle Sidebar" on the shell's
  // own rail. Matching both rather than picking one: the label a viewport
  // renders is t3code's choice and changes with its own layout work.
  const toggle = page.getByRole("button", { name: /toggle (main )?sidebar/i }).first();
  if ((await toggle.count()) > 0) await toggle.click();
  await tree.waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * Quiet the page down before a screenshot a human will judge.
 *
 * Two things otherwise sit on top of the thing under review: t3code's provider
 * update toast, which is real product chrome and nothing to do with this change,
 * and the mobile drawer's open transition, which a screenshot taken too early
 * catches half-faded. Neither is hidden by CSS — the toast is dismissed the way
 * a user dismisses it, so what is captured is a state a user can actually be in.
 */
async function settleForScreenshot(page: Page): Promise<void> {
  const dismissals = page.getByRole("button", { name: /dismiss notification/i });
  for (let index = await dismissals.count(); index > 0; index -= 1) {
    await dismissals.first().click();
  }
  await page.waitForTimeout(700);
}

function subtreeFor(page: Page, architectThreadId: string): Locator {
  return page.locator(
    `[data-testid="sidebar-codev-architect"][data-codev-architect-thread-id="${architectThreadId}"]`,
  );
}

/**
 * The rows in a scope, named by which expected title each one carries.
 *
 * A sidebar card renders the project name, a status, an action and the thread
 * title, and none of them is marked. Reading "the first line" therefore reads the
 * PROJECT name — which is identical on every row, so an assertion built on it
 * passes on any three rows at all. Matching each card against the titles this
 * test is looking for asserts membership and order together, and reports an
 * unmatched row as `null` rather than as a near-miss string.
 */
async function rowsNamedBy(scope: Locator, expected: readonly string[]): Promise<(string | null)[]> {
  const texts = await scope.locator('[data-testid="sidebar-row-card"]').allInnerTexts();
  return texts.map((text) => expected.find((title) => text.includes(title)) ?? null);
}

/**
 * The same rows, sorted, because the order INSIDE a subtree is not this code's.
 *
 * `buildCodevHierarchy` preserves the order it was handed, and the sidebar hands
 * it a list already sorted by recency. Asserting creation order here would be
 * asserting `sortThreadsForSidebar`, which belongs to t3code and changes when the
 * user picks a different sort. What this suite is about is WHICH architect owns
 * each builder — a `null` in the result is a row nested here that should not be.
 */
async function rowsUnder(scope: Locator, expected: readonly string[]): Promise<(string | null)[]> {
  return (await rowsNamedBy(scope, expected)).toSorted((left, right) =>
    left === null ? -1 : right === null ? 1 : left.localeCompare(right),
  );
}

test.beforeEach(() => {
  test.skip(unavailable !== null, unavailable ?? "");
});

/** Criterion 1. */
test("one architect and three builders render as a tree", async ({ page }) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  const subtree = subtreeFor(page, fixture.architectAlpha);
  await expect(subtree).toHaveCount(1);
  await expect(subtree).toHaveAttribute("data-codev-builder-count", "3");

  const builders = subtree.locator('[data-testid="sidebar-codev-builders"]');
  await expect(builders).toHaveCount(1);
  expect(await rowsUnder(builders, fixture.titles.buildersAlpha)).toEqual(
    [...fixture.titles.buildersAlpha].toSorted(),
  );

  // The architect is the row ABOVE its builders, not one of them. Without this
  // the same assertion passes on a flat list that merely contains four rows.
  const architectRow = subtree.locator('[data-testid="sidebar-row-card"]').first();
  await expect(architectRow).toContainText(fixture.titles.architectAlpha);
  const architectBox = await architectRow.boundingBox();
  const builderBox = await builders.locator('[data-testid="sidebar-row-card"]').first().boundingBox();
  expect(architectBox).not.toBeNull();
  expect(builderBox).not.toBeNull();
  // Indented, and below. Two claims because either alone is satisfiable by a
  // layout that is not a tree.
  expect(builderBox!.x).toBeGreaterThan(architectBox!.x);
  expect(builderBox!.y).toBeGreaterThan(architectBox!.y);
});

/**
 * Criterion 1's first level, which the tree did not have until it was reviewed.
 *
 * "Project, architect, that architect's builders" is three levels. A tree with
 * two of them and the project name repeated as a caption on every card is not
 * the third level in a different form: it spends the most prominent line of
 * every row on one string, eight times, and pushes the thread's own name into
 * the line below it.
 */
test("the project is a heading, and its name is not repeated on every row", async ({ page }) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  const heading = page.getByTestId("sidebar-codev-project-heading");
  await expect(heading).toHaveCount(1);
  await expect(heading).toContainText(fixture.projectTitle);

  // Above the tree, not beside it.
  const headingBox = await heading.boundingBox();
  const firstSubtreeBox = await page.getByTestId("sidebar-codev-architect").first().boundingBox();
  expect(headingBox).not.toBeNull();
  expect(firstSubtreeBox).not.toBeNull();
  expect(headingBox!.y).toBeLessThan(firstSubtreeBox!.y);

  // No row inside the tree repeats it. The rows OUTSIDE the tree still carry it
  // — there it is the only thing saying which project they belong to.
  const treeText = await page.getByTestId("sidebar-codev-architect").allInnerTexts();
  for (const text of treeText) {
    expect(text, "a row under the project heading repeated the project name").not.toContain(
      fixture.projectTitle,
    );
  }
  await expect(
    page.getByTestId("sidebar-codev-orphan").filter({ hasText: fixture.projectTitle }),
  ).toHaveCount(1);
});

/**
 * The role, said out loud.
 *
 * Indent alone conveys it only while the threads are called "Architect beta" and
 * "Builder alpha one". Real ones are called `builder/spir-250`, and at that point
 * one level of subtle indent is the entire signal.
 */
test("the architect row says it is an architect", async ({ page }) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  const subtree = subtreeFor(page, fixture.architectAlpha);
  const architectRow = subtree.locator('[data-testid="sidebar-row-card"]').first();
  await expect(architectRow).toContainText("Architect");

  // And its builders do not. A caption on every child of a labelled parent is a
  // caption nobody reads, and "Architect" on a builder row would be a lie.
  const builderTexts = await subtree
    .locator('[data-testid="sidebar-codev-builders"] [data-testid="sidebar-row-card"]')
    .allInnerTexts();
  expect(builderTexts).toHaveLength(3);
  for (const text of builderTexts) {
    expect(text).not.toContain("Architect");
  }
});

/** Criterion 2. */
test("two architects render as two subtrees, each owning its own builders", async ({ page }) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  await expect(page.getByTestId("sidebar-codev-architect")).toHaveCount(2);

  const alpha = subtreeFor(page, fixture.architectAlpha);
  const beta = subtreeFor(page, fixture.architectBeta);
  expect(
    await rowsUnder(
      alpha.locator('[data-testid="sidebar-codev-builders"]'),
      fixture.titles.buildersAlpha,
    ),
  ).toEqual([...fixture.titles.buildersAlpha].toSorted());
  expect(
    await rowsUnder(beta.locator('[data-testid="sidebar-codev-builders"]'), [
      fixture.titles.builderBeta,
    ]),
  ).toEqual([fixture.titles.builderBeta]);
  // Neither subtree claims the other's builders.
  await expect(alpha).not.toContainText(fixture.titles.builderBeta);
  await expect(beta).not.toContainText(fixture.titles.architectAlpha);
});

/** Criterion 7. */
test("a thread with no role appears where it always did, claimed by nothing", async ({ page }) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  const plainRow = page
    .locator('[data-testid="sidebar-row-card"]')
    .filter({ hasText: fixture.titles.plain });
  await expect(plainRow).toHaveCount(1);
  // Not inside a subtree and not inside the orphan group: the tree claims
  // nothing Codev did not create.
  await expect(
    page.getByTestId("sidebar-codev-architect").filter({ hasText: fixture.titles.plain }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("sidebar-codev-orphan").filter({ hasText: fixture.titles.plain }),
  ).toHaveCount(0);
});

/** Criterion 11, rendering half. */
test("a builder whose architect was archived is named as orphaned, with a reason", async ({
  page,
}) => {
  const fixture = seeded;
  if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
  await openSidebar(page);

  await expect(page.getByTestId("sidebar-codev-orphan-heading")).toContainText(
    "Unattributed builders (1)",
  );
  const orphan = page.getByTestId("sidebar-codev-orphan");
  await expect(orphan).toHaveCount(1);
  await expect(orphan).toContainText(fixture.titles.orphan);
  await expect(orphan).toHaveAttribute("data-codev-orphan-reason", "parent-missing");
  // The reason is on the SCREEN, not only in an attribute. A group named
  // "unattributed" with no reason under each row leaves the reader with the
  // same question they opened it to answer.
  await expect(orphan).toContainText("its architect is not in this project");

  // Archived means gone from the sidebar. If the ghost architect were still
  // drawn, the builder would not be an orphan and this whole test would be
  // measuring nothing.
  await expect(page.getByText("Architect ghost")).toHaveCount(0);
});


/**
 * The viewports the criteria name, and what is asserted at each.
 *
 * Three sizes, because a sidebar tree fails differently at each: a 390px page
 * fails by widening (a nested list that adds indent without giving it back),
 * 1440 is the size the design is read at, and 1920 is where a layout that only
 * ever centred one column starts leaving holes.
 *
 * The screenshots are the deliverable a human opens. The assertions are here so
 * that what a human is asked to look at is a page that already passed the
 * measurable half — an eyeballed 12px is a coin flip, and an eyeballed 1px of
 * horizontal overflow is invisible until someone scrolls.
 */
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

/** Text this small is not readable on a phone; 13px is the floor the criteria name. */
const MINIMUM_BODY_TEXT_PX = 13;

for (const viewport of VIEWPORTS) {
  test(`the tree at ${viewport.name}: measured, screenshotted, and free of console errors`, async ({
    page,
  }) => {
    const fixture = seeded;
    if (fixture === null) throw new Error("unreachable: seeded in beforeAll");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    /**
     * Errors are collected AFTER pairing, not from the first navigation.
     *
     * The pairing hop legitimately 401s and retries its socket: the browser has
     * no session until the credential is exchanged. Counting those would make
     * "zero console errors" unachievable for a reason that has nothing to do
     * with the sidebar, and the usual repair — an allow-list of expected errors
     * — is how a real one gets waved through later.
     */
    await openSidebar(page);
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.reload({ waitUntil: "domcontentloaded" });
    await revealSidebar(page);
    await expect(page.getByTestId("sidebar-codev-architect").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("sidebar-codev-orphan")).toHaveCount(1);

    // Nothing widens the page. At 390 this is the assertion that catches an
    // indent added without being given back; at every width it catches a nested
    // list that grew past its container.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the document is ${overflow.scrollWidth - overflow.clientWidth}px wider than the viewport`,
    ).toBe(overflow.clientWidth);

    // Every thread title in the tree, at its computed size. Reading one row
    // would pass a tree whose builders were shrunk to fit the indent.
    // `text-sm` is the thread TITLE. The project label and the status beside it
    // are `text-xs` secondary labels, and measuring those would be measuring
    // t3code's own type scale rather than whether this tree kept it.
    const titleSizes = await page
      .getByTestId("sidebar-codev-architect")
      .locator('[data-testid="sidebar-row-card"] span.text-sm')
      .evaluateAll((nodes) =>
        nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
      );
    expect(titleSizes.length).toBeGreaterThan(0);
    for (const size of titleSizes) {
      expect(size).toBeGreaterThanOrEqual(MINIMUM_BODY_TEXT_PX);
    }

    await settleForScreenshot(page);
    await page.screenshot({ path: forkScreenshotPath(viewport.name), fullPage: true });
    // The sidebar is its own scroll container under a sticky footer, so a
    // full-page shot of a 900px window clips the tail of a longer list — and the
    // tail is the orphan group with its reason line, which is the part a
    // reviewer most needs to see. This second shot is the LIST at its full
    // height, taken at the SAME WIDTH in a tall window so nothing is scrolled
    // out or covered. The width is what the responsive claim is about; the
    // height here is only so the picture is complete.
    await page.setViewportSize({ width: viewport.width, height: 1400 });
    await page.waitForTimeout(400);
    await page
      .getByTestId("sidebar-codev-orphan-heading")
      .locator("xpath=ancestor::ul[1]")
      .screenshot({ path: forkScreenshotPath(`${viewport.name}-tree`) });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // Listed, not counted: a bare "expected 0, got 3" sends the reader back to
    // the browser to find out which three.
    expect(consoleErrors, `console errors at ${viewport.name}`).toEqual([]);
  });
}

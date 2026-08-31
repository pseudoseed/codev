/**
 * Spec 250, phase 8 — a porch gate, in t3code's own web app.
 *
 * ## What this has to prove that a unit test cannot
 *
 * `gateState.test.ts` settles the three states and `GatePanel.test.tsx` settles
 * what each one renders. Neither can say the gate SURVIVES THE TRIP: the block
 * is written through `codev.gateWrite`, allocated a revision by the server,
 * projected onto the thread, and delivered to the browser by subscription. Every
 * defect this project has found so far lived in exactly that kind of hop — phase
 * 3's engine rewriting refusals, phase 4's doing it again, phase 6's ws layer
 * flattening a discriminant — and all of them were green underneath.
 *
 * So the gate here is written by the same RPC and the same scope `codev-agent`
 * uses, against a server built from the fork's source, and read out of a real
 * browser.
 *
 * ## The criterion that is about ABSENCE
 *
 * Spec 146 wrote the gate name into the thread TITLE, because t3code had nowhere
 * else to put it. The plan asks that the title carry no gate name anywhere in the
 * flow, and an absence is the easiest thing to assert wrongly: a test that only
 * checked "the panel shows plan-approval" would pass on a build that ALSO put it
 * back in the title. So the fixture's titles never contain a gate name, and the
 * assertions check the title elements themselves.
 *
 * Running it: see `spec-250-hierarchy.spec.ts` — same stack, same commands, and
 * `pnpm test:e2e:spec250` runs both.
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

test.beforeEach(() => {
  test.skip(unavailable !== null, unavailable ?? "");
});

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

const MINIMUM_BODY_TEXT_PX = 13;

function ready(): { stack: ForkStackReady; seeded: SeededHierarchy } {
  if (stack === null || seeded === null) {
    throw new Error("unreachable: the fork stack is checked before this runs");
  }
  return { stack, seeded };
}

/** Pair a fresh browser context and land on the sidebar. See the phase 7 spec. */
async function openSidebar(page: Page): Promise<void> {
  const { stack: live } = ready();
  const credential = await mintPairingCredential(live);
  await page.goto(`${live.webUrl}/pair#token=${credential}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Enter a pairing token to start a session"),
    "the browser did not pair; every assertion below would be about the pairing form",
  ).toHaveCount(0, { timeout: 30_000 });
  await revealSidebar(page);
}

async function revealSidebar(page: Page): Promise<void> {
  const tree = page.getByTestId("sidebar-codev-architect").first();
  try {
    await tree.waitFor({ state: "visible", timeout: 5_000 });
    return;
  } catch {
    // Off-canvas at 390, or not rendered at all. The toggle distinguishes them.
  }
  const toggle = page.getByRole("button", { name: /toggle (main )?sidebar/i }).first();
  if ((await toggle.count()) > 0) await toggle.click();
  await tree.waitFor({ state: "visible", timeout: 20_000 });
}

/** The sidebar row for one thread, found by the title the fixture gave it. */
function rowFor(page: Page, title: string): Locator {
  return page.locator('[data-testid="sidebar-row-card"]').filter({ hasText: title });
}

/** Open a thread and wait for its gate panel. */
async function openGatedThread(page: Page, title: string): Promise<void> {
  await rowFor(page, title).first().click();
  await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });
}

async function settleForScreenshot(page: Page): Promise<void> {
  const dismissals = page.getByRole("button", { name: /dismiss notification/i });
  for (let index = await dismissals.count(); index > 0; index -= 1) {
    await dismissals.first().click();
  }
  await page.waitForTimeout(700);
}

/** Criterion 3. */
test("a builder stopped at a gate shows the gate name, question and choices", async ({ page }) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);
  await openGatedThread(page, fixture.titles.buildersAlpha[0] ?? "");

  const panel = page.getByTestId("codev-gate-panel");
  await expect(panel).toHaveAttribute("data-codev-gate-name", fixture.gate.name);
  await expect(panel).toHaveAttribute("data-codev-gate-kind", "pending");
  await expect(panel).toContainText(fixture.gate.name);
  await expect(page.getByTestId("codev-gate-question")).toContainText(fixture.gate.question);

  const choices = page.getByTestId("codev-gate-choice");
  await expect(choices).toHaveCount(2);
  // Label AND consequence for each: a panel that showed the labels alone would
  // be asking a human to choose without telling them what either choice does.
  await expect(choices.nth(0)).toContainText(fixture.gate.recommendedLabel);
  await expect(choices.nth(0)).toContainText(fixture.gate.recommendedConsequence);
  await expect(choices.nth(1)).toContainText(fixture.gate.otherLabel);
  await expect(choices.nth(1)).toContainText(fixture.gate.otherConsequence);

  // Exactly one recommendation, on the choice that carried it, in place.
  await expect(page.locator('[data-codev-gate-recommended="true"]')).toHaveCount(1);
  await expect(choices.nth(0)).toHaveAttribute("data-codev-gate-recommended", "true");
  await expect(choices.nth(1)).toHaveAttribute("data-codev-gate-recommended", "false");
});

/**
 * The third state, in the browser.
 *
 * `porch gate <id>` without `--request-file` is legitimate and common. Rendering
 * it as "no gate" hides a human who is waiting.
 */
test("a gate with no structured request says so, and is not mistaken for no gate", async ({
  page,
}) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);
  await openGatedThread(page, fixture.titles.buildersAlpha[1] ?? "");

  const panel = page.getByTestId("codev-gate-panel");
  await expect(panel).toHaveAttribute("data-codev-gate-kind", "pending-unstructured");
  await expect(panel).toContainText(fixture.gate.unstructuredName);
  await expect(panel).toContainText("Gate pending, no structured request");
  // Not an empty question and not an empty choice list — a heading with nothing
  // under it reads as a broken gate rather than an absent request.
  await expect(page.getByTestId("codev-gate-question")).toHaveCount(0);
  await expect(page.getByTestId("codev-gate-choices")).toHaveCount(0);
});

test("a thread with no gate shows no panel at all", async ({ page }) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);
  // The third alpha builder was never gated. Every ungated thread has to look
  // exactly as it did before spec 250.
  await rowFor(page, fixture.titles.buildersAlpha[2] ?? "").first().click();
  await expect(page.getByTestId("codev-gate-panel")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-codev-gate-pill")).toHaveCount(3);
});

/**
 * The gated row is distinguishable from every other row, and from a settled one.
 *
 * `starting` / `running` / `ready` / `settled` cannot express "blocked on a
 * human", so this is its own marker rather than a session status.
 */
test("the sidebar marks the gated builders and nothing else", async ({ page }) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);

  const pills = page.getByTestId("sidebar-codev-gate-pill");
  await expect(pills).toHaveCount(3);
  await expect(pills.filter({ hasText: fixture.gate.name })).toHaveCount(1);
  await expect(pills.filter({ hasText: fixture.gate.unstructuredName })).toHaveCount(1);
  await expect(pills.filter({ hasText: fixture.gate.architectName })).toHaveCount(1);

  // On the right rows, and on no others.
  await expect(rowFor(page, fixture.titles.buildersAlpha[0] ?? "")).toContainText(
    fixture.gate.name,
  );
  await expect(rowFor(page, fixture.titles.buildersAlpha[2] ?? "")).not.toContainText(
    fixture.gate.name,
  );
  await expect(rowFor(page, fixture.titles.architectAlpha)).not.toContainText(fixture.gate.name);

  // The marker outlives a hover. The status slot beside it fades to make room
  // for the row actions, and a gate that vanished when someone reached for the
  // row would be missing exactly when it was being acted on.
  await rowFor(page, fixture.titles.buildersAlpha[0] ?? "").first().hover();
  await expect(pills.filter({ hasText: fixture.gate.name })).toBeVisible();
});

/**
 * An ARCHITECT at a gate keeps BOTH markers.
 *
 * It is the case a human most needs to find, and the one row where two markers
 * compete: the role caption and the gate marker sit on the same line. Neither
 * wins — "which agent is this" and "is it blocking on me" are different
 * questions, and a row that dropped either would answer only one of them. Held
 * up here rather than assumed from reading the JSX.
 */
test("a gated architect shows the role AND the gate, not one or the other", async ({ page }) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);

  const row = rowFor(page, fixture.titles.architectBeta);
  await expect(row).toHaveCount(1);
  // BOTH, and both legible: the role caption is not truncated away to make room
  // for the gate, and the gate is not truncated away to keep the caption.
  await expect(row).toContainText("Architect");
  await expect(row).toContainText(fixture.gate.architectName);
  await expect(row).toContainText(fixture.titles.architectBeta);

  // The subtree still reads as a subtree: its builder is still nested under it.
  const subtree = page.locator(
    `[data-testid="sidebar-codev-architect"][data-codev-architect-thread-id="${fixture.gatedArchitectId}"]`,
  );
  await expect(subtree).toHaveCount(1);
  await expect(subtree).toContainText(fixture.titles.builderBeta);
});

/**
 * THE ABSENCE. Spec 146 put the gate name in the thread title; this asserts it
 * is nowhere near one.
 */
test("no thread title anywhere in the flow contains a gate name", async ({ page }) => {
  const { seeded: fixture } = ready();
  await openSidebar(page);

  // Sidebar titles. `span.text-sm` is the thread title; the project label and
  // the status beside it are `text-xs`.
  const titles = await page.locator('[data-testid="sidebar-row-card"] span.text-sm').allInnerTexts();
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) {
    expect(title, "a sidebar thread title carried the gate name").not.toContain(fixture.gate.name);
    expect(title).not.toContain(fixture.gate.unstructuredName);
  }

  // And the open thread's own header, which is the other place a title renders.
  await openGatedThread(page, fixture.titles.buildersAlpha[0] ?? "");
  const header = page.locator("header").first();
  if ((await header.count()) > 0) {
    await expect(header).not.toContainText(fixture.gate.name);
  }
  const openTitles = await page
    .locator('[data-testid="sidebar-row-card"] span.text-sm')
    .allInnerTexts();
  for (const title of openTitles) {
    expect(title).not.toContain(fixture.gate.name);
  }
});

for (const viewport of VIEWPORTS) {
  test(`the gate panel at ${viewport.name}: measured, screenshotted, and free of console errors`, async ({
    page,
  }) => {
    const { seeded: fixture } = ready();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openSidebar(page);
    await openGatedThread(page, fixture.titles.buildersAlpha[0] ?? "");

    // Collected after pairing and after the thread is open: the pairing hop
    // legitimately 401s and retries its socket before a session exists.
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });

    // Nothing widens the page. The terminal excerpt is the risk here: it is
    // arbitrary-width text, and a panel that let it push the document would take
    // the composer off screen at 390.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `the document is ${overflow.scrollWidth - overflow.clientWidth}px wider than the viewport`,
    ).toBe(overflow.clientWidth);

    // Every line of gate text a human has to read, at its computed size.
    const sizes = await page
      .getByTestId("codev-gate-panel")
      .locator('p, li, [data-testid="codev-gate-question"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
      );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(MINIMUM_BODY_TEXT_PX);
    }

    await settleForScreenshot(page);
    await page.screenshot({ path: forkScreenshotPath("phase-8", viewport.name), fullPage: true });
    await page.setViewportSize({ width: viewport.width, height: 1400 });
    await page.waitForTimeout(400);
    await page
      .getByTestId("codev-gate-panel")
      .screenshot({ path: forkScreenshotPath("phase-8", `${viewport.name}-panel`) });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    expect(consoleErrors, `console errors at ${viewport.name}`).toEqual([]);
  });
}

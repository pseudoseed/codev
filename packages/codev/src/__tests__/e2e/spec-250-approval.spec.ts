/**
 * Spec 250, phase 10 — approving from t3code, in a real browser.
 *
 * ## The claim this exists to make, which no other test can
 *
 * **The page makes no cross-origin request.** The plan's first draft proposed
 * asserting `connect-src 'self'` — and t3code sends no page-level CSP at all
 * (`Content-Security-Policy` appears on `.svg` asset responses only, and
 * `index.html` carries no meta tag), so that assertion would have passed
 * vacuously against a header nobody sends. The guarantee here is structural, not
 * declared: the page has no absolute URL to use. So this WATCHES THE NETWORK —
 * every request the page issues while it pairs, reads state and approves — and
 * asserts each one is on t3code's own origin.
 *
 * ## And the second claim: the panes carry real content now
 *
 * Phases 7-9 rendered "Phase not read here yet — published by codev-agent",
 * which was true and is the sentence this phase removes. The grid here is backed
 * by a real `codev-agent` with real identities, so the panes show a real porch
 * phase and real `afx send` messages — and one pane deliberately shows the
 * "codev-agent does not publish this thread" branch, because that state is
 * ordinary and a screenshot where every pane resolves would hide it.
 *
 * ## Running it
 *
 * Terminal 1, from the fork's `apps/web`, Node 22 on PATH:
 *   T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_PORT=3811 PORT=5733 npx vp dev
 * Terminal 2, from `packages/codev`:
 *   npx playwright test --config playwright.spec250.config.ts
 */

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import * as yaml from "js-yaml";

import {
  AGENT_MACHINE,
  MACHINE_MINT,
  SESSION_MINT,
  startAgentHost,
  type AgentHost,
} from "./spec-250-agent-host";
import { crossOrigin } from "./spec-250-same-origin";
import {
  forkScreenshotPath,
  mintPairingCredential,
  seedApproval,
  startForkStack,
  stopForkStack,
  type ForkStackReady,
  type SeededApproval,
} from "./spec-250-fork-stack";

/** The env var the fork's server reads its codev-agent allowlist from. */
const ORIGINS_ENV = "T3CODE_CODEV_AGENT_ORIGINS";
const TARGET_ID = "local";
const BUILDER_ID = "spir-250";
const PROJECT_ID = "250";
const MACHINE_NAME = "playwright";

let stack: ForkStackReady | null = null;
let seeded: SeededApproval | null = null;
let agent: AgentHost | null = null;
let unavailable: string | null = null;
let previousOrigins: string | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  /*
   * ORDER IS LOAD-BEARING, and it is a circle broken in one place.
   *
   * The fork server reads its allowlist from its environment at start, so the
   * agent host must exist first to have a port. The agent's identities carry
   * t3code thread ids, which do not exist until the fork server is running. So
   * the host starts EMPTY and is seeded after the threads are created.
   */
  agent = await startAgentHost({ builders: [] });
  previousOrigins = process.env[ORIGINS_ENV];
  process.env[ORIGINS_ENV] = `${TARGET_ID}=${agent.origin}`;

  const started = await startForkStack();
  if (!started.available) {
    unavailable = started.reason;
    return;
  }
  stack = started;
  seeded = await seedApproval(started);

  agent.seed({
    architect: { id: "main", threadId: seeded.architectThreadId },
    builders: [
      {
        id: BUILDER_ID,
        threadId: seeded.builderThreadId,
        projectId: PROJECT_ID,
        gateName: seeded.gate.name,
        messages: [
          { from: "architect", body: "Phase 9 accepted. Start phase 10." },
          { from: "architect", body: "Bring screenshots when the panes carry content." },
          { from: "architect", body: "The proxy target is configured, never browser-selected." },
        ],
      },
      // No `projectId`: codev-agent publishes an identity for the architect and
      // this builder, and NOT for the third thread the fixture created.
    ],
  });
});

test.afterAll(() => {
  if (stack !== null) stopForkStack();
  agent?.stop();
  if (previousOrigins === undefined) delete process.env[ORIGINS_ENV];
  else process.env[ORIGINS_ENV] = previousOrigins;
});

test.beforeEach(() => {
  test.skip(unavailable !== null, unavailable ?? "");
});

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

function ready(): { stack: ForkStackReady; seeded: SeededApproval; agent: AgentHost } {
  if (stack === null || seeded === null || agent === null) {
    throw new Error("unreachable: availability is checked before this runs");
  }
  return { stack, seeded, agent };
}


/**
 * Every request the page issued, as absolute URLs.
 *
 * Recording starts before the first navigation, so nothing the page does escapes
 * it — including a request made while a later assertion is still waiting.
 */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => seen.push(request.url()));
  return seen;
}

/** Pair a fresh browser context with t3code itself, and land in the app. */
async function openApp(page: Page, path: string): Promise<void> {
  const { stack: live } = ready();
  const credential = await mintPairingCredential(live);
  await page.goto(`${live.webUrl}/pair#token=${credential}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Enter a pairing token to start a session"),
    "the browser did not pair with t3code; every assertion below would be about the pairing form",
  ).toHaveCount(0, { timeout: 30_000 });
  await page.goto(`${live.webUrl}${path}`, { waitUntil: "domcontentloaded" });
}

/**
 * Pair the page with `codev-agent` through the form the phase built.
 *
 * Driven as a human drives it — typed into the real inputs and submitted —
 * rather than by writing the credential into storage. A test that seeded storage
 * would prove the storage format and say nothing about whether the form works,
 * which is the entry point this phase's deliverable is about.
 */
async function pairWithAgent(page: Page): Promise<void> {
  const { agent: host } = ready();
  const token = host.pairings.issue(MACHINE_MINT).token;
  await page.getByTestId("codev-gate-approval-pair").click();
  await expect(page.getByTestId("codev-pairing-panel")).toBeVisible();
  await expect(page.getByTestId("codev-pairing-target")).toHaveValue(TARGET_ID);
  await page.getByTestId("codev-pairing-machine").fill(MACHINE_NAME);
  await page.getByTestId("codev-pairing-workspace").fill(host.workspacePath);
  await page.getByTestId("codev-pairing-token").fill(token);
  await page.getByTestId("codev-pairing-submit").click();
  await expect(page.getByTestId("codev-pairing-panel")).toHaveCount(0, { timeout: 20_000 });
}

test("the pairing form pairs this browser, and the page never leaves its own origin", async ({
  page,
}) => {
  const { stack: live, seeded: fixture } = ready();
  const requests = recordRequests(page);

  await openApp(page, "/");
  // Open the gated thread, where the gate panel and its Approve action live.
  await openThread(page, fixture.builderTitle);
  await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });

  await pairWithAgent(page);

  // The credential is live: the approve control appears, naming the machine and
  // the configured target rather than an origin.
  await expect(page.getByTestId("codev-gate-approval-machine")).toContainText(MACHINE_NAME);
  await expect(page.getByTestId("codev-gate-approval-machine")).toContainText(TARGET_ID);

  /*
   * THE SAME-ORIGIN ASSERTION, and it is about every request rather than about a
   * header. `codev-agent` is on its own origin and the page has just talked to
   * it; if any of that traffic went direct, it is in this list.
   */
  const origin = new URL(live.webUrl).origin;
  const foreign = crossOrigin(requests, origin);
  expect(foreign, `the page issued cross-origin requests: ${foreign.join(", ")}`).toEqual([]);
  // And it did reach codev-agent — over the proxy path, on this origin. Without
  // this the assertion above passes on a page that made no agent request at all.
  expect(requests.some((url) => url.startsWith(`${origin}/api/codev/agent/${TARGET_ID}/`))).toBe(
    true,
  );
});

test("a pane shows the porch phase and the last messages codev-agent publishes", async ({
  page,
}) => {
  const { stack: live } = ready();
  await openApp(page, "/");
  await openThread(page, ready().seeded.builderTitle);
  await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });
  await pairWithAgent(page);

  await page.goto(`${live.webUrl}/codev-builders`, { waitUntil: "domcontentloaded" });
  const panes = page.getByTestId("codev-builder-pane");
  await expect(panes.first()).toBeVisible({ timeout: 30_000 });

  const managed = panes.filter({ hasText: ready().seeded.builderTitle });
  // The porch phase, from codev-agent. This is the line that read "Phase not read
  // here yet" for three phases.
  await expect(managed.getByTestId("codev-pane-phase")).toHaveAttribute(
    "data-codev-pane-content",
    "known",
    { timeout: 30_000 },
  );
  // BOTH, not one: the gate says who is waiting, the phase says where they got
  // to, and a pane that showed only the gate would drop the second.
  await expect(managed.getByTestId("codev-pane-phase")).toContainText("implement");
  await expect(managed.getByTestId("codev-pane-phase")).toContainText(ready().seeded.gate.name);
  // Three messages, newest first, and the fourth is not there.
  await expect(managed.getByTestId("codev-pane-message")).toHaveCount(3);
  await expect(managed.getByTestId("codev-pane-message").first()).toContainText(
    "configured, never browser-selected",
  );

  /*
   * AND THE PANE THAT CANNOT RESOLVE SAYS SO IN WORDS.
   *
   * codev-agent answered and does not publish this thread. A blank line here
   * would be a claim about the builder rather than about what reached the
   * browser, and it is the branch a screenshot of a fully-resolving grid hides.
   */
  const unmanaged = panes.filter({ hasText: ready().seeded.unmanagedTitle });
  await expect(unmanaged.getByTestId("codev-pane-phase")).toHaveAttribute(
    "data-codev-pane-content",
    "absent",
  );
  await expect(unmanaged.getByTestId("codev-pane-messages-note")).toContainText(
    "does not publish this thread",
  );
});

test("approving from t3code writes the approval porch recorded", async ({ page }) => {
  const { stack: live, seeded: fixture, agent: host } = ready();
  const requests = recordRequests(page);

  await openApp(page, "/");
  await openThread(page, fixture.builderTitle);
  await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });
  await pairWithAgent(page);

  // A session costs its own single-use token, distinct from the machine
  // credential. The form asks for one, so this is the ceremony and not a bypass.
  const sessionToken = host.pairings.issue(SESSION_MINT).token;
  await page.getByTestId("codev-gate-session-token").fill(sessionToken);
  await page.getByTestId("codev-gate-approve").click();

  await expect(page.getByTestId("codev-gate-approval-approved")).toBeVisible({ timeout: 60_000 });
  const approved = page.getByTestId("codev-gate-approval-approved");
  await expect(approved).toContainText(AGENT_MACHINE);

  /*
   * CRITERION 4. The record is porch's, in a real `status.yaml`, and the three
   * fields the criterion names are all there. The page is reporting what the
   * server said rather than what it did.
   */
  const state = yaml.load(readFileSync(host.statusPathFor(BUILDER_ID), "utf8")) as any;
  expect(state.gates[fixture.gate.name].status).toBe("approved");
  expect(state.gates[fixture.gate.name].approval.machine).toBe(AGENT_MACHINE);
  expect(typeof state.gates[fixture.gate.name].approval.session_id).toBe("string");
  expect(Number.isNaN(Date.parse(state.gates[fixture.gate.name].approved_at))).toBe(false);
  await expect(approved).toContainText(state.gates[fixture.gate.name].approval.session_id);

  // Still same-origin, through the whole approval.
  const origin = new URL(live.webUrl).origin;
  const foreign = crossOrigin(requests, origin);
  expect(foreign, `the page issued cross-origin requests: ${foreign.join(", ")}`).toEqual([]);
});

/**
 * The pictures the architect rules on.
 *
 * A green run is not the deliverable — nobody has approved these pane internals,
 * and phase 9 deliberately left that open until real content filled them.
 */
for (const viewport of VIEWPORTS) {
  test(`screenshots at ${viewport.name}`, async ({ page }) => {
    const { stack: live, seeded: fixture } = ready();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openApp(page, "/");
    await openThread(page, fixture.builderTitle);
    await expect(page.getByTestId("codev-gate-panel")).toBeVisible({ timeout: 30_000 });

    // Unpaired first: this is what a human meets before they have a credential,
    // and it is half of what the entry point is judged on.
    await expect(page.getByTestId("codev-gate-approval-unpaired")).toBeVisible();
    await settleForScreenshot(page);
    await page.screenshot({
      path: forkScreenshotPath("phase-10", `gate-unpaired-${viewport.name}`),
      fullPage: false,
    });

    await page.getByTestId("codev-gate-approval-pair").click();
    await expect(page.getByTestId("codev-pairing-panel")).toBeVisible();
    await settleForScreenshot(page);
    await page.screenshot({
      path: forkScreenshotPath("phase-10", `pairing-form-${viewport.name}`),
      fullPage: false,
    });

    await page.getByTestId("codev-pairing-machine").fill(MACHINE_NAME);
    await page.getByTestId("codev-pairing-workspace").fill(ready().agent.workspacePath);
    await page.getByTestId("codev-pairing-token").fill(ready().agent.pairings.issue(MACHINE_MINT).token);
    await page.getByTestId("codev-pairing-submit").click();
    await expect(page.getByTestId("codev-pairing-panel")).toHaveCount(0, { timeout: 20_000 });
    await settleForScreenshot(page);
    await page.screenshot({
      path: forkScreenshotPath("phase-10", `gate-approve-${viewport.name}`),
      fullPage: false,
    });

    await page.goto(`${live.webUrl}/codev-builders`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("codev-builder-pane").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByTestId("codev-builder-pane")
        .filter({ hasText: fixture.builderTitle })
        .getByTestId("codev-pane-phase"),
    ).toHaveAttribute("data-codev-pane-content", "known", { timeout: 30_000 });
    await settleForScreenshot(page);
    await page.screenshot({
      path: forkScreenshotPath("phase-10", `grid-with-content-${viewport.name}`),
      fullPage: false,
    });
  });
}


/**
 * Quiet the page down before a screenshot a human will judge.
 *
 * t3code's provider-update toast is real product chrome and nothing to do with
 * this change, and it sits over the pane grid and the gate panel. Dismissed the
 * way a user dismisses it rather than hidden with CSS, so what is captured is a
 * state a user can actually be in.
 */
async function settleForScreenshot(page: Page): Promise<void> {
  const dismissals = page.getByRole("button", { name: /dismiss notification/i });
  for (let index = await dismissals.count(); index > 0; index -= 1) {
    await dismissals.first().click();
  }
  await page.waitForTimeout(700);
}

/**
 * Open one thread the way a user does.
 *
 * `page.goto` on the thread route proves a route renders and says nothing about
 * whether anything links to it — the defect the phase 9 review found in this
 * suite. The sidebar row is how a person gets here.
 */
async function openThread(page: Page, title: string): Promise<void> {
  const row = page.locator('[data-testid="sidebar-row-card"]').filter({ hasText: title }).first();
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    // Off-canvas at 390. The toggle is how a person reveals it there.
    const toggle = page.getByRole("button", { name: /toggle (main )?sidebar/i }).first();
    if ((await toggle.count()) > 0) await toggle.click();
    await row.waitFor({ state: "visible", timeout: 30_000 });
  }
  await row.click();
}

/**
 * Spec 250, phase 7 — bringing up the fork's own web app so a browser can be
 * pointed at it.
 *
 * ## Why this is a fixture and not four lines in the spec
 *
 * The thing under test is t3code's OWN sidebar, rendered by t3code's OWN web
 * app, against t3code's OWN server. Nothing about that stack is Codev's, and
 * three separate pieces have to agree before a single assertion is meaningful:
 *
 *   the fork SERVER   `t3-server.mjs start-fork`, which runs `apps/server/src/bin.ts`
 *                     from the fork checkout. The published `t3` CLI will not do:
 *                     its contract has no `role` and no `parentThreadId`, so the
 *                     decoder strips them and the sidebar sees a flat list. That
 *                     run would pass and prove nothing.
 *   the fork WEB app  Vite, from `apps/web`, proxying `/api` and `/ws` to the
 *                     server. This fixture does NOT start it — see `probeWebApp`.
 *   a PAIRED browser  the server issues one single-use bootstrap token per start,
 *                     and it is consumed by the first exchange. So the fixture
 *                     spends it once on an access token and mints the browser's
 *                     pairing credential from that.
 *
 * ## The server is restarted, on purpose
 *
 * `start-fork` without `--keep-data` starts on an empty data directory. That is
 * what makes the assertions about ORDER meaningful: a sidebar carrying threads
 * from three previous runs can satisfy "the tree renders" while saying nothing
 * about what is above what. It also re-mints the bootstrap token, which `ready`
 * redacts from the log after handing it over exactly once.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Scopes Codev asks for, plus the one that mints a browser's pairing credential. */
const SEED_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:write",
] as const;

export interface ForkStackUnavailable {
  readonly available: false;
  /**
   * Why, in a sentence a human can act on.
   *
   * Every caller turns this into a SKIP, never a pass. An unreachable dev server
   * and a sidebar with no tree in it are different facts, and spelling them the
   * same way is how a suite reports "I could not tell" as "no".
   */
  readonly reason: string;
}

export interface ForkStackReady {
  readonly available: true;
  readonly webUrl: string;
  readonly serverBase: string;
  readonly accessToken: string;
}

export type ForkStack = ForkStackReady | ForkStackUnavailable;

export interface SeededHierarchy {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly architectAlpha: string;
  readonly architectBeta: string;
  /** Archived after its builder was created, which is what orphans the builder. */
  readonly architectGhost: string;
  readonly titles: {
    readonly architectAlpha: string;
    readonly buildersAlpha: readonly string[];
    readonly architectBeta: string;
    readonly builderBeta: string;
    readonly plain: string;
    readonly orphan: string;
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const harness = resolve(repoRoot, "tools/t3-server/t3-server.mjs");

function harnessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3CODE_ROOT: process.env.T3CODE_ROOT ?? "/Users/chris/dev/t3code",
    T3CODE_FORK_ROOT: process.env.T3CODE_FORK_ROOT ?? "/Users/chris/dev/t3code-codev",
    T3_HARNESS_PORT: process.env.T3_HARNESS_PORT ?? "3811",
  };
}

function runHarness(...args: readonly string[]): string {
  return execFileSync("node", [harness, ...args], { encoding: "utf8", env: harnessEnv() });
}

export function webAppUrl(): string {
  return process.env.T3_WEB_URL ?? "http://localhost:5733";
}

/**
 * Is the fork's web app answering?
 *
 * This fixture will start the SERVER but never the web app: Vite dev is a
 * long-lived foreground process a test has no business owning, and a test that
 * silently started one would leave it running after a failure. So an absent web
 * app is a skip with instructions, not an attempt to fix it.
 */
async function probeWebApp(): Promise<string | null> {
  const url = webAppUrl();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return `${url} answered ${response.status}`;
    return null;
  } catch (error) {
    return `${url} is not answering (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Start the fork server on empty data and return a browser-usable stack.
 *
 * Every failure returns a REASON rather than throwing, because every one of them
 * means "this run cannot tell you anything" and not "the sidebar is wrong".
 */
export async function startForkStack(): Promise<ForkStack> {
  const forkRoot = harnessEnv().T3CODE_FORK_ROOT;
  if (forkRoot === undefined || !existsSync(forkRoot)) {
    return {
      available: false,
      reason:
        `T3CODE_FORK_ROOT is ${forkRoot ?? "unset"}, which does not exist. This spec is ABOUT ` +
        `the fork's web app; there is nothing to fall back to.`,
    };
  }
  if (process.env.T3_NODE === undefined) {
    return {
      available: false,
      reason:
        "T3_NODE is unset. The fork server runs under its own interpreter and does not inherit " +
        "one from PATH.",
    };
  }
  const webProblem = await probeWebApp();
  if (webProblem !== null) {
    return {
      available: false,
      reason:
        `${webProblem}. Start it with: T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_PORT=3811 PORT=5733 ` +
        `npx vp dev, from the fork's apps/web.`,
    };
  }

  try {
    runHarness("stop");
  } catch {
    // Nothing was running. `stop` on an idle port is not a failure.
  }
  let bootstrapToken: string;
  try {
    runHarness("start-fork");
    const readyOutput = runHarness("ready");
    const parsed: unknown = JSON.parse(readyOutput.slice(readyOutput.indexOf("{")));
    const token =
      typeof parsed === "object" && parsed !== null && "token" in parsed
        ? (parsed as { token: unknown }).token
        : undefined;
    if (typeof token !== "string") {
      return { available: false, reason: "the fork server started but printed no pairing token" };
    }
    bootstrapToken = token;
  } catch (error) {
    return {
      available: false,
      reason: `the fork server would not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
  }

  const serverBase = `http://127.0.0.1:${harnessEnv().T3_HARNESS_PORT}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: bootstrapToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: SEED_SCOPES.join(" "),
    client_label: "codev-spec-250-e2e",
    client_device_type: "bot",
  });
  const tokenResponse = await fetch(`${serverBase}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) {
    return {
      available: false,
      reason: `the bootstrap exchange failed with ${tokenResponse.status}`,
    };
  }
  const access = (await tokenResponse.json()) as { readonly access_token: string };
  return {
    available: true,
    webUrl: webAppUrl(),
    serverBase,
    accessToken: access.access_token,
  };
}

/**
 * Where a viewport's screenshot goes.
 *
 * The committed copies live in the FORK, under `docs/codev/` — they are pictures
 * of the fork's UI, and `docs/codev/` is Codev's own rather than mixed into
 * upstream's `architecture` / `internals` / `operations`, which belong to
 * pingdotgg.
 *
 * **Writing there is opt-in, and that is not tidiness.** `start-fork` refuses a
 * dirty fork checkout, so a suite that wrote new PNG bytes into the fork on every
 * run would pass once and then SKIP forever — each run leaving behind the
 * modification that stops the next one. So an ordinary run writes into
 * Playwright's own output directory and leaves the fork clean; refreshing the
 * committed pictures is a deliberate act:
 *
 *   SPEC_250_WRITE_SCREENSHOTS=1 npx playwright test --config playwright.spec250.config.ts
 *
 * then commit them in the fork.
 */
export function forkScreenshotPath(name: string): string {
  if (process.env.SPEC_250_WRITE_SCREENSHOTS === "1") {
    const forkRoot = harnessEnv().T3CODE_FORK_ROOT ?? "";
    return resolve(forkRoot, "docs/codev/spec-250/phase-7", `${name}.png`);
  }
  return resolve(
    import.meta.dirname,
    "../../../test-results/spec-250-screenshots",
    `${name}.png`,
  );
}

export function stopForkStack(): void {
  try {
    runHarness("stop");
  } catch {
    // Already gone.
  }
}

/**
 * A fresh single-use pairing credential for one browser context.
 *
 * One per context, always. The server consumes them on use, so a second page
 * opened with the same credential lands on the pairing form — which looks
 * exactly like a broken sidebar and is not one.
 */
export async function mintPairingCredential(stack: ForkStackReady): Promise<string> {
  const response = await fetch(`${stack.serverBase}/api/auth/pairing-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stack.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label: "spec-250-e2e" }),
  });
  if (!response.ok) {
    throw new Error(`could not mint a pairing credential: ${response.status}`);
  }
  const { credential } = (await response.json()) as { readonly credential: string };
  return credential;
}

interface RpcClient {
  call(method: string, payload: unknown): Promise<unknown>;
}

const uniqueId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Seed one project holding every shape the sidebar has to tell apart.
 *
 * The orphan is made the way a real one is made — an architect is archived after
 * its builder exists — and not by writing an illegal edge. Phase 3 refuses those
 * at write time, so a fixture that produced one would be testing a state this
 * server cannot reach.
 */
export async function seedHierarchy(stack: ForkStackReady): Promise<SeededHierarchy> {
  const clientModule = await import("@cluesmith/t3-client/client");
  const authModule = await import("@cluesmith/t3-client/auth");
  const ticket = await authModule.issueWebSocketTicket(stack.serverBase, stack.accessToken);
  const socket = new WebSocket(authModule.webSocketUrl(stack.serverBase, ticket.ticket));
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("socket error")), { once: true });
  });
  const client = new clientModule.T3Client(
    {
      send: (data: string) => socket.send(data),
      close: () => socket.close(),
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        socket.addEventListener(type as "message", listener as EventListener),
      get readyState() {
        return socket.readyState;
      },
    },
    { requestTimeoutMs: 45_000 },
  ) as unknown as RpcClient;

  const projectId = uniqueId();
  const projectTitle = "spec 250 sidebar";
  const forkRoot = harnessEnv().T3CODE_FORK_ROOT ?? "";
  await client.call("orchestration.dispatchCommand", {
    type: "project.create",
    commandId: uniqueId(),
    projectId,
    title: projectTitle,
    workspaceRoot: forkRoot,
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
    createdAt: new Date().toISOString(),
  });

  const createThread = async (fields: Record<string, unknown>): Promise<void> => {
    await client.call("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: uniqueId(),
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: forkRoot,
      createdAt: new Date().toISOString(),
      projectId,
      ...fields,
    });
  };

  const titles = {
    architectAlpha: "Architect alpha",
    buildersAlpha: ["Builder alpha one", "Builder alpha two", "Builder alpha three"],
    architectBeta: "Architect beta",
    builderBeta: "Builder beta one",
    plain: "Plain upstream thread",
    orphan: "Orphaned builder",
  } as const;

  const architectAlpha = uniqueId();
  const architectBeta = uniqueId();
  const architectGhost = uniqueId();

  await createThread({ threadId: architectAlpha, title: titles.architectAlpha, role: "architect" });
  for (const title of titles.buildersAlpha) {
    await createThread({
      threadId: uniqueId(),
      title,
      role: "builder",
      parentThreadId: architectAlpha,
    });
  }
  await createThread({ threadId: architectBeta, title: titles.architectBeta, role: "architect" });
  await createThread({
    threadId: uniqueId(),
    title: titles.builderBeta,
    role: "builder",
    parentThreadId: architectBeta,
  });
  await createThread({ threadId: uniqueId(), title: titles.plain });
  await createThread({ threadId: architectGhost, title: "Architect ghost", role: "architect" });
  await createThread({
    threadId: uniqueId(),
    title: titles.orphan,
    role: "builder",
    parentThreadId: architectGhost,
  });
  await client.call("orchestration.dispatchCommand", {
    type: "thread.archive",
    commandId: uniqueId(),
    threadId: architectGhost,
  });

  socket.close();
  return { projectId, projectTitle, architectAlpha, architectBeta, architectGhost, titles };
}

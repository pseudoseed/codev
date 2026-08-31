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
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Where the fork's server writes the gate-writer credential at start.
 *
 * Phase 8's fixture needs to write a gate, and it cannot ask for the scope: a
 * bootstrap exchange requesting `codev:gate-write` is refused with
 * `invalid_scope`, which is the phase 4 design working. Gate writes are meant to
 * come from ONE credential — `codev-agent`, scoped to `orchestration:read` and
 * `codev:gate-write` and nothing else — provisioned by the server rather than
 * derived from whatever token a client happens to hold.
 *
 * So the fixture reads that credential from where the server put it, which is
 * also exactly what `thread-backend.ts` does in production. A fixture that
 * obtained the ability some other way would be testing a path no writer uses.
 */
const GATE_WRITER_TOKEN_RELATIVE_PATH = "codev/gate-writer.token";

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
  /**
   * The server-provisioned gate-writer credential, or `null` when the server
   * did not write one.
   *
   * `null` is not "no gates": it means this run cannot write one, and the caller
   * reports that as a skip. An unwritable credential and a gate that failed to
   * render are different facts.
   */
  readonly gateWriterToken: string | null;
}

export type ForkStack = ForkStackReady | ForkStackUnavailable;

export interface SeededHierarchy {
  readonly projectId: string;
  readonly projectTitle: string;
  /**
   * Phase 8. Two gated builders, because the panel has THREE states and only
   * one of them is "no gate": a builder carrying #128's structured request, and
   * one carrying a gate with nothing attached — which is what
   * `porch gate <id>` without `--request-file` produces, and the state most
   * likely to be rendered as "no gate" by mistake.
   */
  readonly gatedBuilderId: string;
  readonly unstructuredGateBuilderId: string;
  /**
   * An ARCHITECT at a gate, which is the case a human most needs to find.
   *
   * It is also the one place two markers compete for the same row: the role
   * caption and the gate marker. Seeded so the answer is measured rather than
   * assumed.
   */
  readonly gatedArchitectId: string;
  readonly gate: {
    readonly name: string;
    readonly unstructuredName: string;
    readonly architectName: string;
    readonly question: string;
    readonly recommendedLabel: string;
    readonly recommendedConsequence: string;
    readonly otherLabel: string;
    readonly otherConsequence: string;
  };
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
 * Start the fork SERVER on empty data, without requiring the web app.
 *
 * Split out of `startForkStack` in phase 10. Phases 7-9 were about what a browser
 * renders, so a missing Vite dev server made a run meaningless. Phase 10's proxy
 * is an HTTP surface on the fork's own server, and a test that drives it over
 * `fetch` needs no page at all — requiring one would skip a run that could have
 * answered.
 *
 * The server reads its codev-agent allowlist from `T3CODE_CODEV_AGENT_ORIGINS` in
 * its OWN environment, and the harness spawns it with `process.env`. So a caller
 * configures the proxy by setting that variable before calling — the same act an
 * operator performs, rather than a fixture-only back door.
 *
 * Every failure returns a REASON rather than throwing: each one means "this run
 * cannot tell you anything", not "the thing under test is wrong".
 */
export async function startForkServer(): Promise<
  ForkStackUnavailable | Omit<ForkStackReady, "webUrl">
> {
  const forkRoot = harnessEnv().T3CODE_FORK_ROOT;
  if (forkRoot === undefined || !existsSync(forkRoot)) {
    return {
      available: false,
      reason:
        `T3CODE_FORK_ROOT is ${forkRoot ?? "unset"}, which does not exist. This spec is ABOUT ` +
        `the fork; there is nothing to fall back to.`,
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
    serverBase,
    accessToken: access.access_token,
    gateWriterToken: readGateWriterToken(),
  };
}

/**
 * Start the fork server AND require its web app, for the specs that render pages.
 *
 * The web app is probed FIRST, before anything is started: an absent Vite is a
 * skip with instructions, and starting a server for a run that cannot proceed
 * leaves a process behind for nothing.
 */
export async function startForkStack(): Promise<ForkStack> {
  const webProblem = await probeWebApp();
  if (webProblem !== null) {
    return {
      available: false,
      reason:
        `${webProblem}. Start it with: T3CODE_SINGLE_ORIGIN_DEV=1 T3CODE_PORT=3811 PORT=5733 ` +
        `npx vp dev, from the fork's apps/web.`,
    };
  }
  const server = await startForkServer();
  if (!server.available) return server;
  return { ...server, webUrl: webAppUrl() };
}

/**
 * Where a viewport's screenshot goes.
 *
 * The committed copies live in the FORK, under `docs/codev/spec-250/<phase>/` —
 * they are pictures of the fork's UI, and `docs/codev/` is Codev's own rather
 * than mixed into upstream's `architecture` / `internals` / `operations`, which
 * belong to pingdotgg.
 *
 * **Nothing writes into the fork directly, and that is not tidiness.**
 * `t3-server.mjs start-fork` refuses a dirty fork checkout, so a suite whose
 * screenshots landed in the fork would poison itself: the first spec file writes
 * new PNG bytes, and every spec file after it SKIPS because the tree it needs is
 * now dirty. It passes, it skips the rest, and the skip is correct behaviour —
 * which is exactly what makes it easy to miss.
 *
 * So a run always writes somewhere outside the fork. Refreshing the committed
 * pictures is a copy afterwards:
 *
 *   SPEC_250_SCREENSHOT_DIR=/tmp/spec-250-shots \
 *     npx playwright test --config playwright.spec250.config.ts
 *   cp -R /tmp/spec-250-shots/. "$T3CODE_FORK_ROOT/docs/codev/spec-250/"
 *
 * then commit them in the fork.
 */
export function forkScreenshotPath(phase: string, name: string): string {
  const root =
    process.env.SPEC_250_SCREENSHOT_DIR ??
    resolve(import.meta.dirname, "../../../test-results/spec-250-screenshots");
  return resolve(root, phase, `${name}.png`);
}

/**
 * Read the gate-writer credential the fork's server wrote at start.
 *
 * Returns `null` rather than throwing: a server without gate support writes no
 * such file, and that is a reason to skip, not a crash.
 */
function readGateWriterToken(): string | null {
  const runtimeDataDir =
    process.env.T3_HARNESS_DIR !== undefined
      ? resolve(process.env.T3_HARNESS_DIR, "data")
      : resolve(repoRoot, "tools/t3-server/.runtime/data");
  const tokenPath = resolve(runtimeDataDir, GATE_WRITER_TOKEN_RELATIVE_PATH);
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    // An empty file is a half-written credential, not an empty one. The server
    // writes `.partial` and renames precisely so a reader never sees that, but a
    // truncated token authenticates like a revoked one.
    return token === "" ? null : token;
  } catch {
    return null;
  }
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
async function connect(
  stack: ForkStackReady,
  accessToken: string,
): Promise<{ client: RpcClient; close: () => void }> {
  const clientModule = await import("@cluesmith/t3-client/client");
  const authModule = await import("@cluesmith/t3-client/auth");
  const ticket = await authModule.issueWebSocketTicket(stack.serverBase, accessToken);
  /*
   * `ws` when the runtime has no global WebSocket, which Node 20 does not.
   *
   * The fork's own tooling wants Node 22, and `better-sqlite3` in this repository
   * is built for Node 20 — so a phase-10 run that needs both a codev-agent and
   * this socket cannot simply pick one interpreter. The polyfill is narrower than
   * the alternative (a child process per agent host) and it is the same protocol
   * either way; `globalThis.WebSocket` is preferred whenever it exists, so a Node
   * 22 run is byte-for-byte what it always was.
   */
  const WebSocketImpl: typeof WebSocket =
    typeof globalThis.WebSocket === "function"
      ? globalThis.WebSocket
      : ((await import("ws")).default as unknown as typeof WebSocket);
  const socket = new WebSocketImpl(authModule.webSocketUrl(stack.serverBase, ticket.ticket));
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
  return { client, close: () => socket.close() };
}

export async function seedHierarchy(stack: ForkStackReady): Promise<SeededHierarchy> {
  const { client, close } = await connect(stack, stack.accessToken);

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
    // None of these names the gate. Spec 146 wrote the gate into the TITLE
    // because there was nowhere else; the assertion that it no longer does
    // needs titles that would make a leak visible.
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
  const alphaBuilderIds: string[] = [];
  for (const title of titles.buildersAlpha) {
    const threadId = uniqueId();
    alphaBuilderIds.push(threadId);
    await createThread({
      threadId,
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

  // ------------------------------------------------------------- the gates
  //
  // Written through `codev.gateWrite`, the same RPC and the same scope
  // `codev-agent` uses. Not by writing the column, and not by dispatching a
  // thread command: the revision is server-allocated, and a fixture that
  // invented one would be seeding a state the real writer cannot produce.
  const gatedBuilderId = alphaBuilderIds[0];
  const unstructuredGateBuilderId = alphaBuilderIds[1];
  if (gatedBuilderId === undefined || unstructuredGateBuilderId === undefined) {
    throw new Error("unreachable: three alpha builders are created above");
  }
  const gate = {
    name: "plan-approval",
    unstructuredName: "spec-approval",
    architectName: "verify-approval",
    question: "Delete the legacy table, or keep it for audit purposes?",
    recommendedLabel: "Delete it",
    recommendedConsequence: "Migrate references, drop the table, and open the PR.",
    otherLabel: "Keep it",
    otherConsequence: "Retain the table and document the audit dependency.",
  } as const;

  //
  // On its OWN connection, with the server's own credential. Not on the socket
  // above: that one carries `orchestration:operate`, and putting gate writes on
  // it is precisely what phase 4 gave the method a separate scope to prevent.
  if (stack.gateWriterToken === null) {
    throw new Error(
      "the fork server wrote no gate-writer credential, so this fixture cannot write a gate",
    );
  }
  const gateWriter = await connect(stack, stack.gateWriterToken);
  await gateWriter.client.call("codev.gateWrite", {
    type: "codev.gate.set",
    commandId: uniqueId(),
    threadId: gatedBuilderId,
    createdAt: new Date().toISOString(),
    gate: {
      gateName: gate.name,
      requestedAt: new Date().toISOString(),
      question: gate.question,
      choices: [
        {
          label: gate.recommendedLabel,
          consequence: gate.recommendedConsequence,
          recommended: true,
        },
        { label: gate.otherLabel, consequence: gate.otherConsequence },
      ],
      terminalExcerpt: "warning: legacy references remain\ncheckout tests failed",
    },
  });
  await gateWriter.client.call("codev.gateWrite", {
    type: "codev.gate.set",
    commandId: uniqueId(),
    threadId: unstructuredGateBuilderId,
    createdAt: new Date().toISOString(),
    gate: { gateName: gate.unstructuredName, requestedAt: new Date().toISOString() },
  });
  await gateWriter.client.call("codev.gateWrite", {
    type: "codev.gate.set",
    commandId: uniqueId(),
    threadId: architectBeta,
    createdAt: new Date().toISOString(),
    gate: {
      gateName: gate.architectName,
      requestedAt: new Date().toISOString(),
      question: "Merge the branch, or hold for the second review?",
      choices: [{ label: "Merge", consequence: "Merge and close the issue." }],
    },
  });

  gateWriter.close();
  close();
  return {
    projectId,
    projectTitle,
    architectAlpha,
    architectBeta,
    architectGhost,
    titles,
    gatedBuilderId,
    unstructuredGateBuilderId,
    gatedArchitectId: architectBeta,
    gate,
  };
}


export interface SeededTiling {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly architectTitle: string;
  readonly builderTitles: readonly string[];
}

/**
 * One architect and six builders, and nothing else, for the tiling measurement.
 *
 * A separate seeding from `seedHierarchy` on purpose. The grid is not scoped to
 * a project — it shows the agents Codev is running in this workspace — so a run
 * that also carried the hierarchy fixture's threads would be measuring a grid
 * with a pane count nobody chose. The fixture restarts the server on empty data,
 * which is what makes "exactly seven panes" a fact rather than a hope.
 *
 * SEVEN panes is the point. Criterion 5 wants six builders watchable at
 * 1440x900; criterion 5b wants seven panes at 1920 tiling 4x2 rather than 3x3,
 * and seven is the count that tells the fewest-rows rule apart from a
 * near-square one — both give three columns at 1440.
 */
export async function seedTiling(stack: ForkStackReady): Promise<SeededTiling> {
  const { client, close } = await connect(stack, stack.accessToken);
  const projectId = uniqueId();
  const projectTitle = "spec 250 tiling";
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

  const architectTitle = "Architect main";
  const architectId = uniqueId();
  await createThread({ threadId: architectId, title: architectTitle, role: "architect" });
  const builderTitles = [
    "Builder one",
    "Builder two",
    // Deliberately long, and it is the only reason the role-prefix test can
    // fail. With six short titles a pane never runs out of room, so a prefix
    // that COULD be clipped never is — and a test that cannot fail is not a
    // test. Real builder threads are named `builder/spir-250 gate rendering in
    // t3code` and worse.
    "Builder three with a deliberately very long thread title that will not fit a pane",
    "Builder four",
    "Builder five",
    "Builder six",
  ];
  for (const title of builderTitles) {
    await createThread({
      threadId: uniqueId(),
      title,
      role: "builder",
      parentThreadId: architectId,
    });
  }

  close();
  return { projectId, projectTitle, architectTitle, builderTitles };
}

/**
 * Spec 250, phase 10 — threads whose IDS are returned, so a `codev-agent` can be
 * seeded to publish about them.
 *
 * `seedHierarchy` and `seedTiling` return titles, because those specs read the
 * sidebar and the grid by what a human sees. This one has a second consumer: the
 * agent host, whose identities carry `thread_id` and must line up with the
 * threads t3code is showing, or every pane truthfully reports "codev-agent does
 * not publish this thread" and the phase's content is never rendered.
 */
export interface SeededApproval {
  readonly projectId: string;
  readonly architectThreadId: string;
  readonly architectTitle: string;
  readonly builderThreadId: string;
  readonly builderTitle: string;
  /** A second builder, with no porch project, so "absent" is rendered too. */
  readonly unmanagedThreadId: string;
  readonly unmanagedTitle: string;
  readonly gate: {
    readonly name: string;
    readonly question: string;
    readonly recommendedLabel: string;
  };
}

export async function seedApproval(stack: ForkStackReady): Promise<SeededApproval> {
  const { client, close } = await connect(stack, stack.accessToken);
  const projectId = uniqueId();
  const forkRoot = harnessEnv().T3CODE_FORK_ROOT ?? "";
  await client.call("orchestration.dispatchCommand", {
    type: "project.create",
    commandId: uniqueId(),
    projectId,
    title: "spec 250 approval",
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

  const architectThreadId = uniqueId();
  const architectTitle = "Architect main";
  await createThread({ threadId: architectThreadId, title: architectTitle, role: "architect" });

  const builderThreadId = uniqueId();
  const builderTitle = "Builder at a gate";
  await createThread({
    threadId: builderThreadId,
    title: builderTitle,
    role: "builder",
    parentThreadId: architectThreadId,
  });

  /*
   * A builder codev-agent knows nothing about.
   *
   * "The agent answered and does not publish this thread" is a real, ordinary
   * state and its own branch in the pane. Without one seeded, that branch is
   * never rendered and the screenshots would show a grid where every pane
   * happens to resolve.
   */
  const unmanagedThreadId = uniqueId();
  const unmanagedTitle = "Builder codev-agent does not know";
  await createThread({
    threadId: unmanagedThreadId,
    title: unmanagedTitle,
    role: "builder",
    parentThreadId: architectThreadId,
  });

  const gate = {
    name: "pr",
    question: "Approve the plan, or send it back for another round?",
    recommendedLabel: "Approve",
  } as const;

  // Through `codev.gateWrite`, with the server's own credential, on its own
  // connection — the same RPC and scope `codev-agent` uses. See `seedHierarchy`.
  if (stack.gateWriterToken === null) {
    throw new Error(
      "the fork server wrote no gate-writer credential, so this fixture cannot write a gate",
    );
  }
  const gateWriter = await connect(stack, stack.gateWriterToken);
  await gateWriter.client.call("codev.gateWrite", {
    type: "codev.gate.set",
    commandId: uniqueId(),
    threadId: builderThreadId,
    createdAt: new Date().toISOString(),
    gate: {
      gateName: gate.name,
      requestedAt: new Date().toISOString(),
      question: gate.question,
      choices: [
        {
          label: gate.recommendedLabel,
          consequence: "Implementation starts on the plan as written.",
          recommended: true,
        },
        { label: "Send it back", consequence: "The plan is revised first." },
      ],
    },
  });
  gateWriter.close();
  close();

  return {
    projectId,
    architectThreadId,
    architectTitle,
    builderThreadId,
    builderTitle,
    unmanagedThreadId,
    unmanagedTitle,
    gate,
  };
}

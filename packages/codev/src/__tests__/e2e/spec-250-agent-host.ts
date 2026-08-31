/**
 * Spec 250, phase 10 — a real `codev-agent` for the fork's proxy to reach.
 *
 * Shared by the two tests that need one, and shared rather than copied for the
 * usual reason: the vitest e2e drives the proxy over `fetch` and the Playwright
 * spec drives it from a page, and if the two built their own hosts they would
 * drift into testing two different services.
 *
 * ## What it is
 *
 * `agent-routes` in-process on a random port, over a real workspace holding a
 * real porch project at a pending gate. Nothing here writes `status.yaml` —
 * porch does, which is the whole point of asserting the file afterwards.
 *
 * ## What it seeds, and why identity seeding is not optional
 *
 * `codev-agent` publishes an identity per row in `architect` / `builders`, and
 * attaches a porch projection by matching the row's WORKTREE against the
 * artifact root of a status record found under it. So a host with no rows
 * publishes an empty workspace — which a pane would render as "not published",
 * truthfully, and prove nothing about the phase actually appearing.
 *
 * The seeded rows carry the caller's own thread ids, so the identities line up
 * with the t3code threads the fork's web app is showing.
 */

import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

import { GLOBAL_SCHEMA } from "../../agent-farm/db/schema.js";
import { ApprovalCapabilityStore, ApprovalNonceStore } from "../../agent-farm/lib/approval-capability.js";
import { MachineCredentialStore } from "../../agent-farm/lib/machine-credentials.js";
import { PairingStore } from "../../agent-farm/lib/pairing.js";
import {
  HumanPairedSessionRegistry,
  handleAgentRoute,
  initAgentRoutes,
  shutdownAgentRoutes,
} from "../../agent-farm/servers/agent-routes.js";
import { normalizeWorkspacePath } from "../../agent-farm/utils/workspace-path.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** The machine name every capability is issued FOR. Asserted, not assumed. */
export const AGENT_MACHINE = "test-machine";

export interface SeededBuilder {
  /** The builder id, e.g. `spir-250`. Its digits resolve the porch project. */
  readonly id: string;
  /** The t3code thread this row is the identity of. */
  readonly threadId: string;
  /** Porch project id. Left absent for a builder with no project. */
  readonly projectId?: string;
  /** A gate to leave pending, with #128's structured request attached. */
  readonly gateName?: string;
  /** Messages addressed to this builder, newest last — the agent reverses. */
  readonly messages?: readonly { readonly from: string; readonly body: string }[];
}

export interface AgentHostSeed {
  readonly architect?: { readonly id: string; readonly threadId: string };
  readonly builders: readonly SeededBuilder[];
}

export interface AgentHost {
  readonly origin: string;
  readonly port: number;
  readonly workspacePath: string;
  readonly encodedWorkspace: string;
  readonly pairings: PairingStore;
  readonly machines: MachineCredentialStore;
  /** Add identities after the host is running. See {@link startAgentHost}. */
  seed(seed: AgentHostSeed): void;
  /** Where a seeded builder's `status.yaml` lives, for asserting the approval. */
  statusPathFor(builderId: string): string;
  stop(): void;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "codev-spec250-agent-"));
}

function projectDirName(projectId: string): string {
  // REAL PROJECTS ARE NAMED `<id>-<slug>`, never bare `<id>`. A fixture using the
  // bare form hides any code that builds a path from the id.
  return `${projectId}-spec-250`;
}

/**
 * The workspace root, with porch's checks skipped.
 *
 * These tests are about whether an approval can be reached from a browser, not
 * about whether a throwaway directory can run a build, and the skip goes through
 * the mechanism porch supports for exactly that.
 */
function makeWorkspaceRoot(): string {
  const root = tempDir();
  mkdirSync(join(root, ".codev"), { recursive: true });
  writeFileSync(
    join(root, ".codev", "config.json"),
    JSON.stringify({ porch: { checks: { build: { skip: true }, tests: { skip: true } } } }),
  );
  return root;
}

/** One worktree per builder, each holding a porch project. */
function seedWorktrees(root: string, seed: AgentHostSeed): void {
  for (const builder of seed.builders) {
    if (builder.projectId === undefined) continue;
    const worktree = join(root, ".builders", builder.id);
    const projectDir = join(worktree, "codev", "projects", projectDirName(builder.projectId));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "status.yaml"),
      yaml.dump({
        id: builder.projectId,
        title: "spec 250 approval from t3code",
        protocol: "air",
        phase: "implement",
        plan_phases: [],
        current_plan_phase: null,
        gates:
          builder.gateName === undefined
            ? {}
            : {
                [builder.gateName]: {
                  status: "pending",
                  requested_at: "2026-08-30T00:00:00.000Z",
                  request: {
                    question: "Approve the plan, or send it back for another round?",
                    choices: [
                      {
                        label: "Approve",
                        consequence: "Implementation starts on the plan as written.",
                        recommended: true,
                      },
                      { label: "Send it back", consequence: "The plan is revised first." },
                    ],
                  },
                },
              },
        iteration: 1,
        build_complete: false,
        history: [],
      }),
    );
    // The real protocol definitions, so `approve` runs real phase checks rather
    // than a shape invented here.
    cpSync(join(REPO_ROOT, "codev-skeleton", "protocols"), join(worktree, "codev", "protocols"), {
      recursive: true,
    });
  }
}

function seedRows(database: Database.Database, workspace: string, seed: AgentHostSeed): void {
  if (seed.architect !== undefined) {
    database
      .prepare(
        `INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
         VALUES (?, ?, 0, 0, 'claude', NULL, ?)`,
      )
      .run(workspace, seed.architect.id, seed.architect.threadId);
  }
  for (const builder of seed.builders) {
    database
      .prepare(
        `INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, thread_id, spawned_by_architect)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        workspace,
        builder.id,
        builder.id,
        join(workspace, ".builders", builder.id),
        `builder/${builder.id}`,
        builder.threadId,
        seed.architect?.id ?? null,
      );
    /*
     * ASCENDING timestamps, one second apart.
     *
     * `recentByAgent` orders by `created_at DESC, id DESC`, so messages inserted
     * within the same millisecond tie and fall back to the id — which is random
     * here. A test asserting "the last three, newest first" over a tie is a test
     * that passes on the order the ids happened to sort in.
     */
    let messageAt = Date.now() - (builder.messages ?? []).length * 1_000;
    for (const message of builder.messages ?? []) {
      messageAt += 1_000;
      database
        .prepare(
          `INSERT INTO mailbox (id, workspace_path, to_agent, from_agent, body, formatted_message, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, ?)`,
        )
        .run(
          `${builder.id}-${Math.random().toString(36).slice(2, 10)}`,
          workspace,
          builder.id,
          message.from,
          message.body,
          message.body,
          messageAt,
          messageAt,
        );
    }
  }
}

/**
 * Start a real `codev-agent` over a freshly seeded workspace.
 *
 * `seed` may be added to AFTER the host is running, and the Playwright spec needs
 * that: the fork's server has to be started with this host's port in its
 * environment, and only then can t3code threads be created — so the thread ids
 * the identities carry do not exist yet at start.
 */
export async function startAgentHost(seed: AgentHostSeed): Promise<AgentHost> {
  const workspaceRoot = makeWorkspaceRoot();
  const stateRoot = tempDir();
  const workspace = normalizeWorkspacePath(workspaceRoot);
  const pairings = new PairingStore({ root: join(stateRoot, "pairing") });
  const machines = new MachineCredentialStore({ root: join(stateRoot, "machines") });
  const database = new Database(":memory:");
  database.exec(GLOBAL_SCHEMA);
  const seeded: SeededBuilder[] = [];
  const applySeed = (next: AgentHostSeed): void => {
    seedWorktrees(workspaceRoot, next);
    seedRows(database, workspace, next);
    seeded.push(...next.builders);
  };
  applySeed(seed);

  initAgentRoutes({
    db: () => database,
    log: (level, message) => {
      if (level === "ERROR") console.error(message);
    },
    isKnownWorkspace: (candidate) => normalizeWorkspacePath(candidate) === workspace,
    humanSessions: new HumanPairedSessionRegistry(),
    approvalCapabilities: new ApprovalCapabilityStore({
      root: join(stateRoot, "approval"),
      machine: AGENT_MACHINE,
    }),
    approvalNonces: new ApprovalNonceStore({ root: join(stateRoot, "approval") }),
    machineCredentials: machines,
    pairings,
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (handleAgentRoute(request, response, url)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    workspacePath: workspace,
    encodedWorkspace: Buffer.from(workspace, "utf8").toString("base64url"),
    pairings,
    machines,
    seed: applySeed,
    statusPathFor(builderId: string): string {
      const builder = seeded.find((candidate) => candidate.id === builderId);
      if (builder?.projectId === undefined) {
        throw new Error(`builder ${builderId} was seeded with no porch project`);
      }
      return join(
        workspaceRoot,
        ".builders",
        builderId,
        "codev",
        "projects",
        projectDirName(builder.projectId),
        "status.yaml",
      );
    },
    stop(): void {
      shutdownAgentRoutes();
      server.close();
      database.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

/** Every mint names its ceremony and what authorized it. */
export const MACHINE_MINT = {
  purpose: "machine-credential" as const,
  authority: "test harness",
};
export const SESSION_MINT = { purpose: "client-session" as const, authority: "test harness" };

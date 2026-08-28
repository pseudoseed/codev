#!/usr/bin/env node

// Issue #146 feasibility proof. This deliberately drives only t3's public
// headless HTTP/WebSocket boundary; it does not import or modify t3 source.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const port = Number(process.env.T3_PROOF_PORT ?? 3791);
const baseUrl = `http://127.0.0.1:${port}`;
const pauseMs = Number(process.env.T3_PROOF_PAUSE_MS ?? 36 * 60 * 1000);
const allowShortPause = process.env.T3_PROOF_ALLOW_SHORT_PAUSE === "1";
const keepTemp = process.env.T3_PROOF_KEEP_TEMP === "1";
const dataDir = await mkdtemp(join(tmpdir(), "t3code-porch-proof-"));
const seedRepo = join(dataDir, "seed-repo");
const contextToken = `CTX_${Date.now()}`;
const externalToken = crypto.randomUUID().slice(0, 8);

const methods = {
  dispatch: "orchestration.dispatchCommand",
  subscribeThread: "orchestration.subscribeThread",
  createWorktree: "vcs.createWorktree",
};

const rpcGroup = RpcGroup.make(
  Rpc.make(methods.dispatch, {
    payload: Schema.Unknown,
    success: Schema.Unknown,
    error: Schema.Unknown,
  }),
  Rpc.make(methods.subscribeThread, {
    payload: Schema.Unknown,
    success: Schema.Unknown,
    error: Schema.Unknown,
    stream: true,
  }),
  Rpc.make(methods.createWorktree, {
    payload: Schema.Unknown,
    success: Schema.Unknown,
    error: Schema.Unknown,
  }),
);

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const timeout = (label, ms) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms));
const waitPromise = (promise, label, ms = 10 * 60 * 1000) =>
  Effect.promise(() => Promise.race([promise, timeout(label, ms)]));

const shell = (command, cwd) => {
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Shell failed (${result.status}): ${command}\n${result.stderr}`);
  }
  return result.stdout.trim();
};

await mkdir(seedRepo);
await writeFile(join(seedRepo, "README.md"), "isolated t3 porch proof\n");
shell("git init -q && git config user.email proof@example.invalid && git config user.name 'Proof Spike' && git add README.md && git commit -qm seed", seedRepo);

let serverLog = "";
const serverReady = deferred();
const server = spawn(
  "npx",
  [
    "--yes",
    "t3@0.0.35",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    dataDir,
    "--log-ws-events",
    seedRepo,
  ],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);

const consumeServer = (chunk) => {
  const text = chunk.toString();
  serverLog += text;
  process.stderr.write(text);
  const match = serverLog.match(/^Token: (.+)$/m);
  if (match) serverReady.resolve(match[1].trim());
};
server.stdout.on("data", consumeServer);
server.stderr.on("data", consumeServer);
server.once("exit", (code, signal) => {
  if (!serverLog.match(/^Token: (.+)$/m)) {
    serverReady.resolve(Promise.reject(new Error(`t3 exited before ready: ${code}/${signal}`)));
  }
});

const exchangeToken = async (bootstrapToken) => {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: bootstrapToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read orchestration:operate terminal:operate review:write relay:read",
    client_label: "porch-proof-spike",
    client_device_type: "bot",
    client_os: process.platform,
  });
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  return response.json();
};

let accessToken;
const wsLayer = async () => {
  const response = await fetch(`${baseUrl}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`WS ticket failed: ${response.status} ${await response.text()}`);
  const ticket = await response.json();
  const wsUrl = `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`;
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const withClient = async (use) => {
  const layer = await wsLayer();
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(rpcGroup);
      return yield* use(client);
    }),
  ).pipe(Effect.provide(layer));
};

const processSnapshot = (label) => {
  const ps = shell("ps -axo pid=,ppid=,rss=,command=", process.cwd());
  const rows = ps.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] } : null;
  }).filter(Boolean);
  const descendants = new Set([server.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const owned = rows.filter((row) => descendants.has(row.pid));
  const snapshot = {
    label,
    at: now(),
    totalRssKb: owned.reduce((sum, row) => sum + row.rssKb, 0),
    processes: owned.map(({ pid, ppid, rssKb, command }) => ({ pid, ppid, rssKb, command: command.slice(0, 180) })),
    dataDirKb: Number(shell(`du -sk ${JSON.stringify(dataDir)} | awk '{print $1}'`, process.cwd())),
  };
  console.log("RESOURCE_SNAPSHOT", JSON.stringify(snapshot));
  return snapshot;
};

const assistantText = (events, threadId, afterSequence, throughSequence = Infinity) =>
  events
    .filter((item) =>
      item?.kind === "event" &&
      item.event.sequence > afterSequence &&
      item.event.sequence <= throughSequence &&
      item.event.aggregateId === threadId &&
      item.event.type === "thread.message-sent" &&
      item.event.payload?.role === "assistant")
    .map((item) => item.event.payload.text)
    .join("");

const bootstrapToken = await Promise.race([serverReady.promise, timeout("t3 server ready", 60_000)]);
accessToken = (await exchangeToken(bootstrapToken)).access_token;
console.log("PROOF_ENV", JSON.stringify({ dataDir, seedRepo, port, pauseMs, serverPid: server.pid }));

const modelSelection = { instanceId: "codex", model: "gpt-5.6-luna" };
const projectId = id();
const primaryThreadId = id();
const allEvents = [];
const lastSequenceByThread = new Map();
const turnWaiters = new Map();
const activeThreads = new Set();

const onEvent = (item) => {
  if (item?.kind !== "event") return;
  allEvents.push(item);
  lastSequenceByThread.set(item.event.aggregateId, item.event.sequence);
  if (item.event.type !== "thread.session-set") return;
  const waiter = turnWaiters.get(item.event.aggregateId);
  if (!waiter) return;
  const session = item.event.payload?.session;
  if (session?.activeTurnId != null) {
    activeThreads.add(item.event.aggregateId);
    waiter.seenRunning = true;
    waiter.running.resolve(session);
  } else if (waiter.seenRunning) {
    activeThreads.delete(item.event.aggregateId);
    turnWaiters.delete(item.event.aggregateId);
    waiter.settled.resolve(session);
  }
};

const makeTurnWaiter = (threadId) => {
  const waiter = { seenRunning: false, running: deferred(), settled: deferred() };
  turnWaiters.set(threadId, waiter);
  return waiter;
};

let proofResult;
try {
  proofResult = await Effect.runPromise(
    await withClient((client) =>
      Effect.gen(function* () {
        const dispatch = (command) => client[methods.dispatch](command);
        yield* dispatch({
          type: "project.create",
          commandId: id(),
          projectId,
          title: "Issue 146 porch execution proof",
          workspaceRoot: seedRepo,
          defaultModelSelection: modelSelection,
          createdAt: now(),
        });

        const primaryWorktree = yield* client[methods.createWorktree]({
          cwd: seedRepo,
          refName: "HEAD",
          newRefName: `proof-primary-${Date.now()}`,
          path: null,
        });
        const worktreePath = primaryWorktree.worktree.path;
        yield* dispatch({
          type: "thread.create",
          commandId: id(),
          threadId: primaryThreadId,
          projectId,
          title: "porch multi-turn and gate proof",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: primaryWorktree.worktree.refName,
          worktreePath,
          createdAt: now(),
        });

        const primarySync = deferred();
        yield* client[methods.subscribeThread]({
          threadId: primaryThreadId,
          requestCompletionMarker: true,
        }).pipe(
          Stream.runForEach((item) => Effect.sync(() => {
            if (item?.kind === "event") onEvent(item);
            if (item?.kind === "synchronized") primarySync.resolve();
          })),
          Effect.forkScoped,
        );
        yield* waitPromise(primarySync.promise, "primary subscription synchronized", 30_000);

        const startTurn = (threadId, text) => {
          const startSequence = lastSequenceByThread.get(threadId) ?? 0;
          const waiter = makeTurnWaiter(threadId);
          return {
            startSequence,
            waiter,
            dispatch: dispatch({
              type: "thread.turn.start",
              commandId: id(),
              threadId,
              message: { messageId: id(), role: "user", text, attachments: [] },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: now(),
            }),
          };
        };

        // 1. Multi-turn, with an external shell mutation between settled turns.
        const turn1 = startTurn(primaryThreadId,
          `Remember the conversation token ${contextToken}. Reply with exactly TURN1_READY_${contextToken}. Do not modify files.`);
        yield* turn1.dispatch;
        yield* waitPromise(turn1.waiter.settled.promise, "turn 1 activeTurnId null");
        const turn1End = lastSequenceByThread.get(primaryThreadId);
        const turn1Text = assistantText(allEvents, primaryThreadId, turn1.startSequence, turn1End);

        const externalCommand = `printf '%s\\n' ${JSON.stringify(externalToken)} > proof-external.txt`;
        shell(externalCommand, worktreePath);
        console.log("EXTERNAL_SHELL", JSON.stringify({ cwd: worktreePath, command: externalCommand, content: shell("cat proof-external.txt", worktreePath) }));

        const turn2 = startTurn(primaryThreadId,
          "Use a shell command to read proof-external.txt. Reply as EXTERNAL_SEEN_<file content>_<the conversation token I asked you to remember in turn 1>. Do not ask me for either value.");
        yield* turn2.dispatch;
        yield* waitPromise(turn2.waiter.settled.promise, "turn 2 activeTurnId null");
        const turn2End = lastSequenceByThread.get(primaryThreadId);
        const turn2Text = assistantText(allEvents, primaryThreadId, turn2.startSequence, turn2End);
        const proof1 = turn1Text.includes(`TURN1_READY_${contextToken}`) &&
          turn2Text.includes(`EXTERNAL_SEEN_${externalToken}_${contextToken}`);
        console.log("RESULT_1", JSON.stringify({ verdict: proof1 ? "PROVEN" : "FAILED", turn1End, turn2End, turn1Text, turn2Text, externalToken, contextToken }));
        if (!proof1) throw new Error("proof 1 output assertions failed");

        const beforePauseResources = processSnapshot("one-settled-thread-before-pause");
        const pauseStartedAt = Date.now();
        console.log("GATE_PAUSE_START", JSON.stringify({ at: new Date(pauseStartedAt).toISOString(), pauseMs }));
        yield* Effect.sleep(`${pauseMs} millis`);
        const pauseEndedAt = Date.now();
        console.log("GATE_PAUSE_END", JSON.stringify({ at: new Date(pauseEndedAt).toISOString(), elapsedMs: pauseEndedAt - pauseStartedAt, reaperObserved: serverLog.includes("provider.session.reaped") }));

        // 2. Resume the exact same thread after the real idle period. With the
        // default 36-minute pause, this also crosses the 30m reaper + 5m sweep.
        const turn3 = startTurn(primaryThreadId,
          "Without using tools or reading files, reply as PAUSE_RESUMED_<the conversation token I asked you to remember before the pause>_<the file content you read immediately before the pause>. Do not ask me for either value.");
        yield* turn3.dispatch;
        yield* waitPromise(turn3.waiter.settled.promise, "post-gate turn activeTurnId null");
        const turn3End = lastSequenceByThread.get(primaryThreadId);
        const turn3Text = assistantText(allEvents, primaryThreadId, turn3.startSequence, turn3End);
        const reaperObserved = serverLog.includes("provider.session.reaped") && serverLog.includes(primaryThreadId);
        const recalledContext = turn3Text.includes(`PAUSE_RESUMED_${contextToken}_${externalToken}`);
        const proof2 = allowShortPause
          ? recalledContext
          : pauseEndedAt - pauseStartedAt >= 10 * 60 * 1000 && reaperObserved && recalledContext;
        console.log("RESULT_2", JSON.stringify({ verdict: allowShortPause && proof2 ? "SMOKE_ONLY" : proof2 ? "PROVEN" : "FAILED", elapsedMs: pauseEndedAt - pauseStartedAt, reaperObserved, recalledContext, turn3End, turn3Text }));
        if (!proof2) throw new Error("proof 2 output assertions failed");
        const afterPauseResources = processSnapshot("one-thread-after-pause-and-resume");

        // 3. Keep this control subscription alive. A second WS subscribes,
        // observes the run start, and then deliberately closes. The control
        // captures the authoritative event list while that WS is absent.
        const auxSynced = deferred();
        const auxSawRunning = deferred();
        const auxItemsBeforeDrop = [];
        const auxStartSequence = lastSequenceByThread.get(primaryThreadId) ?? 0;
        const auxFiber = yield* Effect.promise(async () =>
          Effect.runPromise(
            await withClient((auxClient) =>
              Effect.gen(function* () {
                yield* auxClient[methods.subscribeThread]({
                  threadId: primaryThreadId,
                  afterSequence: auxStartSequence,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.runForEach((item) => Effect.sync(() => {
                    if (item?.kind === "event") {
                      auxItemsBeforeDrop.push(item);
                      const session = item.event.type === "thread.session-set" ? item.event.payload?.session : null;
                      if (session?.activeTurnId != null) auxSawRunning.resolve();
                    }
                    if (item?.kind === "synchronized") auxSynced.resolve();
                  })),
                  Effect.forkScoped,
                );
                yield* waitPromise(auxSynced.promise, "aux WS initial synchronization", 30_000);
                yield* waitPromise(auxSawRunning.promise, "aux WS running event", 120_000);
              }),
            ),
          ),
        ).pipe(Effect.forkScoped);
        yield* waitPromise(auxSynced.promise, "aux connection ready", 30_000);

        const turn4 = startTurn(primaryThreadId,
          "Run this shell command: sleep 8; printf RECONNECT_COMMAND_DONE. Then reply exactly RECONNECT_TURN_DONE.");
        yield* turn4.dispatch;
        yield* waitPromise(auxSawRunning.promise, "aux observes running", 120_000);
        yield* Fiber.await(auxFiber);
        const lastBeforeDisconnect = auxItemsBeforeDrop.at(-1)?.event?.sequence ?? auxStartSequence;
        const disconnectedAt = Date.now();
        console.log("WS_DROPPED", JSON.stringify({ lastBeforeDisconnect, disconnectedAt: new Date(disconnectedAt).toISOString() }));
        yield* waitPromise(turn4.waiter.settled.promise, "turn settles while aux WS disconnected");
        const settledSequence = lastSequenceByThread.get(primaryThreadId);

        const replayItems = [];
        const replaySynced = deferred();
        yield* Effect.promise(async () =>
          Effect.runPromise(
            await withClient((replayClient) =>
              Effect.gen(function* () {
                yield* replayClient[methods.subscribeThread]({
                  threadId: primaryThreadId,
                  afterSequence: lastBeforeDisconnect,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.runForEach((item) => Effect.sync(() => {
                    if (item?.kind === "event") replayItems.push(item);
                    if (item?.kind === "synchronized") replaySynced.resolve();
                  })),
                  Effect.forkScoped,
                );
                yield* waitPromise(replaySynced.promise, "replay synchronization", 30_000);
              }),
            ),
          ),
        );

        const expectedItems = allEvents.filter((item) =>
          item.event.aggregateId === primaryThreadId &&
          item.event.sequence > lastBeforeDisconnect &&
          item.event.sequence <= settledSequence);
        const expectedIds = expectedItems.map((item) => item.event.eventId);
        const replayIds = replayItems
          .filter((item) => item.event.sequence <= settledSequence)
          .map((item) => item.event.eventId);
        const replayCompletion = replayItems.some((item) =>
          item.event.type === "thread.session-set" && item.event.payload?.session?.activeTurnId === null);
        const turn4Text = assistantText(allEvents, primaryThreadId, turn4.startSequence, settledSequence);
        const proof3 = JSON.stringify(expectedIds) === JSON.stringify(replayIds) &&
          replayCompletion && turn4Text.includes("RECONNECT_TURN_DONE");
        console.log("RESULT_3", JSON.stringify({ verdict: proof3 ? "PROVEN" : "FAILED", lastBeforeDisconnect, settledSequence, expectedSequences: expectedItems.map((item) => item.event.sequence), replaySequences: replayItems.map((item) => item.event.sequence), expectedIds, replayIds, replayCompletion, turn4Text }));
        if (!proof3) throw new Error("proof 3 replay assertions failed");

        // Supplemental six-thread capacity observation, not product code.
        const extraThreads = [];
        for (let index = 1; index <= 5; index += 1) {
          const threadId = id();
          const worktree = yield* client[methods.createWorktree]({
            cwd: seedRepo,
            refName: "HEAD",
            newRefName: `proof-six-${index}-${Date.now()}`,
            path: null,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: id(),
            threadId,
            projectId,
            title: `six-thread capacity ${index}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: worktree.worktree.refName,
            worktreePath: worktree.worktree.path,
            createdAt: now(),
          });
          const synced = deferred();
          yield* client[methods.subscribeThread]({ threadId, requestCompletionMarker: true }).pipe(
            Stream.runForEach((item) => Effect.sync(() => {
              if (item?.kind === "event") onEvent(item);
              if (item?.kind === "synchronized") synced.resolve();
            })),
            Effect.forkScoped,
          );
          yield* waitPromise(synced.promise, `thread ${index} subscription`, 30_000);
          extraThreads.push({ index, threadId, worktreePath: worktree.worktree.path });
        }

        const six = [{ index: 0, threadId: primaryThreadId, worktreePath }, ...extraThreads];
        const sixTurns = [];
        for (const entry of six) {
          const turn = startTurn(entry.threadId, `Run sleep 10, then reply exactly SIX_OK_${entry.index}.`);
          yield* turn.dispatch;
          sixTurns.push({ ...entry, ...turn });
        }
        yield* waitPromise(Promise.all(sixTurns.map((entry) => entry.waiter.running.promise)), "all six threads running", 5 * 60 * 1000);
        const allSixSimultaneouslyActive = six.every((entry) => activeThreads.has(entry.threadId));
        const sixActiveResources = processSnapshot("six-concurrent-active-turns");
        yield* waitPromise(Promise.all(sixTurns.map((entry) => entry.waiter.settled.promise)), "all six threads settled", 10 * 60 * 1000);
        const sixResults = sixTurns.map((entry) => {
          const endSequence = lastSequenceByThread.get(entry.threadId);
          const text = assistantText(allEvents, entry.threadId, entry.startSequence, endSequence);
          return { index: entry.index, threadId: entry.threadId, endSequence, ok: text.includes(`SIX_OK_${entry.index}`), text };
        });
        const sixProven = allSixSimultaneouslyActive && sixResults.every((entry) => entry.ok);
        console.log("SIX_THREAD_RESULT", JSON.stringify({ verdict: sixProven ? "PROVEN" : "FAILED", allSixSimultaneouslyActive, results: sixResults, resources: sixActiveResources }));
        if (!sixProven) throw new Error("six-thread concurrency assertions failed");

        return {
          proofs: { proof1, proof2, proof3 },
          primaryThreadId,
          worktreePath,
          pauseStartedAt,
          pauseEndedAt,
          reaperObserved,
          resources: { beforePauseResources, afterPauseResources, sixActiveResources },
          sixResults,
        };
      }),
    ),
  );
  console.log("FINAL_RESULT", JSON.stringify(proofResult));
} finally {
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), sleep(10_000)]);
  await writeFile(join(dataDir, "captured-server.log"), serverLog);
  console.log("SERVER_LOG_WRITTEN", join(dataDir, "captured-server.log"));
  if (!keepTemp) {
    console.log("TEMP_RETAINED_FOR_EVIDENCE", dataDir);
  }
}

#!/usr/bin/env node

// Follow-up for an already reaped proof thread. The prompt deliberately does
// not contain the expected pre-reap fact.
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const dataDir = process.env.T3_PROOF_DATA_DIR;
const threadId = process.env.T3_PROOF_THREAD_ID;
const port = Number(process.env.T3_PROOF_PORT ?? 3792);
if (!dataDir || !threadId) throw new Error("T3_PROOF_DATA_DIR and T3_PROOF_THREAD_ID are required");
const workspace = `${dataDir}/seed-repo`;
const baseUrl = `http://127.0.0.1:${port}`;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const wait = (signal, label, ms = 120_000) => Effect.promise(() => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  signal.promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, reject);
}));

const methods = { dispatch: "orchestration.dispatchCommand", subscribe: "orchestration.subscribeThread" };
const group = RpcGroup.make(
  Rpc.make(methods.dispatch, { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make(methods.subscribe, { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown, stream: true }),
);

let log = "";
const ready = deferred();
const server = spawn("npx", ["--yes", "t3@0.0.35", "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", dataDir, "--log-ws-events", workspace], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const consume = (chunk) => {
  const text = chunk.toString();
  log += text;
  process.stderr.write(text);
  const token = log.match(/^Token: (.+)$/m)?.[1];
  if (token) ready.resolve(token.trim());
};
server.stdout.on("data", consume);
server.stderr.on("data", consume);

try {
  const bootstrap = await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("server timeout")), 60_000))]);
  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate terminal:operate review:write relay:read",
      client_label: "porch-proof-resume-check",
      client_device_type: "bot",
      client_os: process.platform,
    }),
  });
  const access = (await tokenResponse.json()).access_token;
  const ticketResponse = await fetch(`${baseUrl}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${access}` } });
  const ticket = (await ticketResponse.json()).ticket;
  const wsUrl = `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}`;
  const layer = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
    Layer.provide(RpcSerialization.layerJson),
  );
  const output = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* RpcClient.make(group);
    const synced = deferred();
    const running = deferred();
    const settled = deferred();
    let sawRunning = false;
    yield* client[methods.subscribe]({ threadId, requestCompletionMarker: true }).pipe(
      Stream.runForEach((item) => Effect.sync(() => {
        if (item?.kind === "synchronized") synced.resolve();
        if (item?.kind !== "event") return;
        if (item.event.type === "thread.message-sent" && item.event.payload?.role === "assistant") output.push(item.event.payload.text);
        if (item.event.type === "thread.session-set") {
          if (item.event.payload?.session?.activeTurnId != null) {
            sawRunning = true;
            running.resolve();
          } else if (sawRunning) settled.resolve(item.event.sequence);
        }
      })),
      Effect.forkScoped,
    );
    yield* wait(synced, "sync");
    output.length = 0;
    yield* client[methods.dispatch]({
      type: "thread.turn.start",
      commandId: id(),
      threadId,
      message: {
        messageId: id(),
        role: "user",
        text: "Without using tools, what exact filename did I ask you to read before the long gate pause? Reply as PRE_REAP_FILENAME_<your answer>.",
        attachments: [],
      },
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now(),
    });
    yield* wait(running, "running");
    const endSequence = yield* wait(settled, "settled");
    const text = output.join("");
    const verdict = text.includes("PRE_REAP_FILENAME_proof-external.txt") ? "PROVEN" : "FAILED";
    console.log("CONTEXT_RESUME_RESULT", JSON.stringify({ verdict, threadId, endSequence, text }));
    if (verdict !== "PROVEN") throw new Error("pre-reap context was not recalled");
  })).pipe(Effect.provide(layer)));
} finally {
  server.kill("SIGTERM");
}

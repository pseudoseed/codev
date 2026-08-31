/**
 * Spec 250, Phase 6 — the last hop, against a live FORK server.
 *
 * ## Why this file exists at all
 *
 * Phase 3 gave the fork six `CodevHierarchyInvalidReason` discriminants and
 * tested them at the decider. Phase 3's review then found `OrchestrationEngine`
 * rewriting every one of them into "Failed to generate an event identifier" —
 * green in every test beneath the layer that broke them. Phase 4 found the same
 * function deleting gate refusals, in the same way, one phase later.
 *
 * Both were caught below the boundary a real client crosses. **This runs above
 * it.** A discriminant that does not survive serialization does not exist, and
 * the only way to know is to dispatch an illegal edge over a socket and read what
 * comes back.
 *
 * ## It needs the FORK server, and that is not the harness's usual one
 *
 * `t3-server.mjs start` runs the PUBLISHED `t3@<pin.cliVersion>` CLI against the
 * upstream checkout, which is what every spec 146 measurement is about. That
 * server has no `codev.*` anything: `parentThreadId` is not in its contract, so an
 * illegal edge is not illegal there, it is an unknown field the decoder strips.
 * Testing against it would produce a passing run that proves nothing.
 *
 * So this uses `start-fork`, which runs the fork's `apps/server/src/bin.ts`
 * directly, on its own port and its own runtime directory. It never touches the
 * upstream server or its data.
 *
 * Usage:
 *   export T3_NODE=/absolute/path/to/node
 *   export T3CODE_FORK_ROOT=/path/to/fork T3_HARNESS_PORT=<free> T3_HARNESS_DIR=<dir>
 *   node packages/t3-client/live/spec-250-hierarchy.mjs --out codev/research/250-hierarchy-wire-evidence.json
 *
 * Exit 0 when every claim held, 1 when one did not, 3 when it could not tell.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OK = 0;
const MISMATCH = 1;
const UNDETERMINED = 3;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const distDir = join(here, '..', 'dist');

const die = (code, message) => {
  console.error(`[spec-250-hierarchy] ${message}`);
  process.exit(code);
};

if (!existsSync(join(distDir, 'client.js'))) {
  die(
    UNDETERMINED,
    `COULD_NOT_TELL: ${distDir} has no built client. Run the workspace build first — a missing `
      + `build is not a failing wire test.`,
  );
}

const FORK_ROOT = process.env.T3CODE_FORK_ROOT;
if (!FORK_ROOT || !existsSync(FORK_ROOT)) {
  die(
    UNDETERMINED,
    `COULD_NOT_TELL: T3CODE_FORK_ROOT is ${FORK_ROOT ? `${FORK_ROOT}, which does not exist` : 'unset'}. `
      + `This test is ABOUT the fork's server; there is nothing to fall back to.`,
  );
}

const { T3Client } = await import(join(distDir, 'client.js'));
const auth = await import(join(distDir, 'auth.js'));

const port = Number(process.env.T3_HARNESS_PORT ?? 3799);
const base = `http://127.0.0.1:${port}`;
const run = (...args) => execFileSync('node', [harness, ...args], { encoding: 'utf8' });
const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? resolve(repoRoot, process.argv[outIdx + 1]) : null;

const claims = [];
const record = (name, passed, detail) => claims.push({ name, passed, detail });

let ACCESS = null;
async function accessToken() {
  if (ACCESS) return ACCESS;
  const readyOut = run('ready');
  const { token } = JSON.parse(readyOut.slice(readyOut.indexOf('{')));
  ACCESS = await auth.exchangeBootstrapToken(base, token, { clientLabel: 'codev-spec250-live' });
  return ACCESS;
}

const clients = [];
async function connect() {
  const access = await accessToken();
  const ticket = await auth.issueWebSocketTicket(base, access.access_token);
  const socket = new WebSocket(auth.webSocketUrl(base, ticket.ticket));
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', () => rej(new Error('socket error')), { once: true });
  });
  const client = new T3Client(
    {
      send: (d) => socket.send(d),
      close: () => socket.close(),
      addEventListener: (t, l) => socket.addEventListener(t, l),
      get readyState() { return socket.readyState; },
    },
    { requestTimeoutMs: 45_000 },
  );
  clients.push({ client, socket });
  return client;
}

/**
 * Dispatch a `thread.create` and return what came back off the WIRE.
 *
 * The three shapes are kept apart on purpose:
 *
 *   accepted   the server applied it. For an illegal edge that is a FAILURE of
 *              this test, not an error of the harness.
 *   refused    an `RpcFailureError` carrying a domain error. `tag` and `reason`
 *              are read through the client's own accessors, which is what a real
 *              caller would use.
 *   opaque     it failed and carried no readable reason — the exact condition
 *              this file exists to detect. Never spelled like `refused`.
 */
async function createThread(client, fields) {
  try {
    await client.call('orchestration.dispatchCommand', {
      type: 'thread.create',
      commandId: id(),
      modelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      branch: null,
      worktreePath: FORK_ROOT,
      createdAt: now(),
      ...fields,
    });
    return { kind: 'accepted' };
  } catch (error) {
    if (error?.name !== 'RpcFailureError') {
      return { kind: 'opaque', detail: `${error?.name ?? 'unknown'}: ${String(error?.message ?? error).slice(0, 200)}` };
    }
    const domain = error.error;
    /**
     * `refusal` FIRST, and this is the whole finding.
     *
     * The first draft of this file read `domain.reason`, on the assumption that
     * the `CodevHierarchyInvalidError` itself reaches the client. It does not —
     * `ws.ts` wraps every dispatch failure in `OrchestrationDispatchCommandError`
     * — so the reason was undefined and the run reported `opaque` for all four
     * cases. That was a TRUE reading of the server as it stood: the discriminant
     * existed only inside the message.
     *
     * The fork now lifts it onto `refusal`, so that is where a client reads it.
     * `domain.reason` is still checked as a fallback because a future path could
     * surface the tagged error directly, and a client that knew only one shape
     * would report a readable refusal as opaque.
     */
    const refusal = domain && typeof domain === 'object' ? domain.refusal : undefined;
    const reason = (refusal && typeof refusal === 'object' ? refusal.reason : undefined)
      ?? (domain && typeof domain === 'object' ? domain.reason : undefined);
    if (typeof reason !== 'string') {
      return {
        kind: 'opaque',
        detail:
          `the refusal reached the client with tag ${JSON.stringify(error.tag)} and no readable reason: `
          + `${JSON.stringify(domain).slice(0, 300)}`,
      };
    }
    return {
      kind: 'refused',
      // The REFUSING error's tag, not the envelope's. `error.tag` is always
      // `OrchestrationDispatchCommandError` now, which says nothing about what
      // refused; `refusal.tag` is the error that made the decision.
      tag: (refusal && typeof refusal === 'object' ? refusal.tag : undefined) ?? error.tag,
      reason,
      parentThreadId: domain?.parentThreadId ?? null,
    };
  }
}

// ---------------------------------------------------------------- setup

try { run('stop'); } catch { /* nothing running */ }
run('start-fork');
run('verify-fork');

let exitCode = OK;
try {
  const client = await connect();

  const projectA = id();
  const projectB = id();
  for (const [projectId, title] of [[projectA, 'spec 250 wire A'], [projectB, 'spec 250 wire B']]) {
    await client.call('orchestration.dispatchCommand', {
      type: 'project.create',
      commandId: id(),
      projectId,
      title,
      workspaceRoot: projectId === projectA ? FORK_ROOT : join(FORK_ROOT, 'apps'),
      defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.6-luna' },
      createdAt: now(),
    });
  }

  const architect = id();
  const builder = id();
  const architectElsewhere = id();

  // ---------------------------------------------------------- the legal edges

  const madeArchitect = await createThread(client, {
    threadId: architect, projectId: projectA, title: 'architect', role: 'architect',
  });
  record('an architect thread is accepted with a role and no parent', madeArchitect.kind === 'accepted', JSON.stringify(madeArchitect));

  const madeBuilder = await createThread(client, {
    threadId: builder, projectId: projectA, title: 'builder', role: 'builder', parentThreadId: architect,
  });
  record('a builder thread is accepted with its architect as parent', madeBuilder.kind === 'accepted', JSON.stringify(madeBuilder));

  await createThread(client, {
    threadId: architectElsewhere, projectId: projectB, title: 'architect elsewhere', role: 'architect',
  });

  // ------------------------------------------------ the discriminants, on the wire

  /**
   * The four the server must decide, each with a DIFFERENT answer.
   *
   * The criterion is not "it refused" — a single opaque failure would satisfy
   * that. It is that a client can tell "no such parent" from "wrong parent role",
   * which needs the reasons to arrive intact AND to differ.
   */
  const cases = [
    {
      name: 'parent-not-found',
      fields: { threadId: id(), projectId: projectA, title: 'orphan', role: 'builder', parentThreadId: id() },
    },
    {
      name: 'parent-not-architect',
      fields: { threadId: id(), projectId: projectA, title: 'nested builder', role: 'builder', parentThreadId: builder },
    },
    {
      name: 'parent-in-other-project',
      fields: { threadId: id(), projectId: projectA, title: 'cross project', role: 'builder', parentThreadId: architectElsewhere },
    },
  ];

  const observed = {};
  for (const testCase of cases) {
    const outcome = await createThread(client, testCase.fields);
    observed[testCase.name] = outcome;
    record(
      `${testCase.name} arrives as a readable reason`,
      outcome.kind === 'refused' && outcome.reason === testCase.name,
      JSON.stringify(outcome),
    );
  }

  // `parent-is-self` needs the thread to name its own id, which no other case can
  // stand in for.
  const selfId = id();
  const self = await createThread(client, {
    threadId: selfId, projectId: projectA, title: 'self parent', role: 'builder', parentThreadId: selfId,
  });
  observed['parent-is-self'] = self;
  record('parent-is-self arrives as a readable reason', self.kind === 'refused' && self.reason === 'parent-is-self', JSON.stringify(self));

  /**
   * THE CRITERION, stated as its own claim.
   *
   * Four refusals with four different reasons. If the engine collapsed them — as
   * it did in phase 3 and again in phase 4 — every one of them would still be a
   * refusal, and this is the assertion that would fail.
   */
  const reasons = Object.values(observed)
    .filter((o) => o.kind === 'refused')
    .map((o) => o.reason);
  record(
    'the four reasons are distinguishable from one another',
    new Set(reasons).size === 4,
    `reasons: ${JSON.stringify(reasons)}`,
  );

  record(
    'every refusal carried the CodevHierarchyInvalidError tag',
    Object.values(observed).every((o) => o.kind === 'refused' && o.tag === 'CodevHierarchyInvalidError'),
    JSON.stringify(Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, v.tag ?? v.kind]))),
  );

  /**
   * The sources this run depended on, hashed.
   *
   * NOT mtimes and NOT commit times. Review found the mtime form flakes on a
   * fresh clone — git writes files in whatever order it likes, so the evidence
   * can look older than a source it is current with. Commit time fixes that and
   * breaks differently: a file written, run, and THEN committed always looks
   * newer than the run it produced, which is the ordinary way this file is
   * edited.
   *
   * A content hash is neither. It answers the question the guard actually means —
   * "is this evidence about the code that is here now?" — and it is the same
   * mechanism `generated/source-hash.json` already uses for the contract.
   *
   * The client's read path is in the list because the whole claim is that a
   * CLIENT can read the discriminant: `envelope.ts` is where `RpcFailureError`
   * decides what `error` and `tag` mean.
   */
  const sourceHashes = {};
  for (const relative of [
    'packages/t3-client/live/spec-250-hierarchy.mjs',
    'packages/t3-client/src/envelope.ts',
    'packages/t3-client/src/client.ts',
    'tools/t3-server/t3-server.mjs',
  ]) {
    sourceHashes[relative] = createHash('sha256')
      .update(readFileSync(join(repoRoot, relative)))
      .digest('hex');
  }

  const evidence = {
    _comment:
      'Spec 250 phase 6. Generated by packages/t3-client/live/spec-250-hierarchy.mjs against a live '
      + 'FORK server started with `t3-server.mjs start-fork`. Do not hand-edit.',
    recordedAt: now(),
    forkRoot: FORK_ROOT,
    forkCommit: execFileSync('git', ['-C', FORK_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    port,
    algorithm: 'sha256',
    sourceHashes,
    observed,
    claims,
    passed: claims.every((c) => c.passed),
  };
  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, rendered);
  else console.log(rendered);

  for (const claim of claims) {
    console.error(`[spec-250-hierarchy] ${claim.passed ? 'ok  ' : 'FAIL'} ${claim.name}`);
    if (!claim.passed) console.error(`                        ${claim.detail}`);
  }
  exitCode = evidence.passed ? OK : MISMATCH;
} catch (error) {
  console.error(`[spec-250-hierarchy] COULD_NOT_TELL: ${error instanceof Error ? error.stack : String(error)}`);
  exitCode = UNDETERMINED;
} finally {
  for (const { socket } of clients) {
    try { socket.close(); } catch { /* already closing */ }
  }
  try { run('stop'); } catch { /* already stopped */ }
}
process.exit(exitCode);

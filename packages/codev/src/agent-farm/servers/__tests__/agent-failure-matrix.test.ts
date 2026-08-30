/**
 * Spec 146 Phase 5: one test per failure-matrix row, each asserting that
 * row's own distinct signal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../../db/schema.js';
import { normalizeWorkspacePath } from '../../utils/workspace-path.js';
import { classifyDualServiceFailure, FAILURE_MATRIX_SIGNAL } from '../agent-failure.js';
import { APPROVAL_SIGNAL, ApprovalCapabilityStore, ApprovalNonceStore } from '../../lib/approval-capability.js';
import { MachineCredentialStore } from '../../lib/machine-credentials.js';
import { PairingStore } from '../../lib/pairing.js';
import {
  handleAgentRoute,
  HumanPairedSessionRegistry,
  initAgentRoutes,
  shutdownAgentRoutes,
  HUMAN_SESSION_HEADER,
  MACHINE_CREDENTIAL_HEADER,
} from '../agent-routes.js';
import { readScopedStatus, readStatusesFromArtifactRoot, readWorkspaceStatuses } from '../status-reader.js';
import { readThreadRegistry } from '../thread-registry.js';
import { watchAgentState, type AgentStateStreamEvent } from '../agent-state-stream.js';
import type { FSWatcher } from 'node:fs';

const SIGNAL = FAILURE_MATRIX_SIGNAL;

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  return db;
}

function writeStatus(
  root: string,
  projectId: string,
  body: string,
): string {
  const dir = join(root, 'codev', 'projects', `${projectId}-proj`);
  mkdirSync(dir, { recursive: true });
  const statusPath = join(dir, 'status.yaml');
  writeFileSync(statusPath, body);
  return statusPath;
}

function porchYaml(projectId: string, extra = ''): string {
  return [
    `id: '${projectId}'`,
    'title: test',
    'protocol: air',
    'phase: implement',
    'current_plan_phase: null',
    'gates:',
    '  pr:',
    '    status: pending',
    extra,
  ].filter((line) => line !== '').join('\n') + '\n';
}

function insertBuilder(
  db: Database.Database,
  row: { workspace: string; id: string; worktree: string; threadId: string },
): void {
  db.prepare(`
    INSERT INTO builders (workspace_path, id, name, worktree, branch, thread_id)
    VALUES (?, ?, ?, ?, 'builder/test', ?)
  `).run(
    normalizeWorkspacePath(row.workspace),
    row.id,
    row.id,
    row.worktree,
    row.threadId,
  );
}

function deafWatch(_path: string): FSWatcher {
  const watcher = {
    close() {},
    on() { return watcher; },
  };
  return watcher as unknown as FSWatcher;
}

function phaseSnapshot(root: string): { artifactRoots: string[]; payload: { phase: string } } {
  const results = readStatusesFromArtifactRoot(root);
  const ok = results.find((result) => result.ok);
  return {
    artifactRoots: [root],
    payload: { phase: ok && ok.ok ? ok.status.phase : 'missing' },
  };
}

function fakeRes(): { statusCode: number; body: string; res: http.ServerResponse } {
  const captured = { statusCode: 0, body: '', res: null as unknown as http.ServerResponse };
  captured.res = {
    writeHead(code: number) {
      captured.statusCode = code;
    },
    end(b?: string) {
      captured.body = b ?? '';
    },
  } as unknown as http.ServerResponse;
  return captured;
}

/** A request whose body arrives in one chunk, then ends. */
function fakeReq(method: string, headers: Record<string, string>, body: string): http.IncomingMessage {
  const listeners: Record<string, Array<(value?: unknown) => void>> = {};
  const req = {
    method,
    headers,
    destroy: () => undefined,
    on(event: string, handler: (value?: unknown) => void) {
      (listeners[event] ??= []).push(handler);
      if (event === 'end') {
        queueMicrotask(() => {
          for (const dataHandler of listeners.data ?? []) dataHandler(Buffer.from(body, 'utf8'));
          for (const endHandler of listeners.end ?? []) endHandler();
        });
      }
      return req;
    },
  } as unknown as http.IncomingMessage;
  return req;
}

/** Let the queued body delivery and the handler's promise chain run. */
function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-fail-'));
  tmpDirs.push(dir);
  return dir;
}

function db(): Database.Database {
  const instance = memoryDb();
  dbs.push(instance);
  return instance;
}

afterEach(() => {
  shutdownAgentRoutes();
  for (const instance of dbs.splice(0)) instance.close();
  for (const dir of tmpDirs.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* restore may already have run */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('failure matrix signals are distinct', () => {
  // This asserts the CONSTANT, not the emitter. Read on: the emitter produces
  // codes beyond the matrix, and a length check here cannot see them.
  it('names only unique codes in the documented matrix', () => {
    const codes = Object.values(SIGNAL);
    // Uniqueness is worth asserting; the COUNT is not. A hand-maintained number
    // drifts the moment someone adds a code, and the passing test then reads as
    // coverage of a set it never looked at. See the emitter-derived test below,
    // which is the one that actually fails when a code escapes.
    expect(new Set(codes).size).toBe(codes.length);
  });

  // DERIVED FROM THE EMITTER, NOT FROM A LITERAL.
  //
  // The previous assertion was `expect(Object.values(SIGNAL)).toHaveLength(12)`,
  // which compares the constant to itself. It looks like a completeness claim and
  // is not one: production emits codes that were never in `SIGNAL` at all, and that
  // test passed throughout. Replacing it with a bigger number, or with a second
  // hand-written list of "codes beyond the matrix", reproduces the same defect one
  // layer out — it breaks when someone forgets to update a literal, which is not
  // when we need to hear about it.
  //
  // So this reads the emitters and fails on any code that is in NEITHER the matrix
  // NOR the explicitly justified non-matrix set below. Add a code to production and
  // this test tells you to classify it.
  it('every code production can emit is either a matrix row or explicitly excluded', () => {
    // Not matrix rows, each for a stated reason. This list is allowed to exist only
    // because every entry names why it is not an operator-facing failure row.
    const NON_MATRIX: Record<string, string> = {
      // status-reader's internal read outcomes. NOT_FOUND and OUT_OF_SCOPE are
      // routing/containment results, not service failures an operator diagnoses.
      STATUS_NOT_FOUND: 'a project without status.yaml is absence, not failure',
      STATUS_OUT_OF_SCOPE: 'path containment refusal, a security response not a failure mode',
      // thread-registry's finer-grained cousins of matrix rows. Each IS covered by
      // its own mutation-verified test above; they are excluded from the matrix
      // because the matrix row is the coarser operator-facing one.
      GLOBAL_DB_UNREADABLE: 'non-lock db failure; distinct from GLOBAL_DB_LOCKED and tested',
      PORCH_RECORD_UNMAPPED: 'no identity row; distinct from PORCH_THREAD_NO_LONGER_EXISTS and tested',
      PORCH_JOIN_AMBIGUOUS: 'several candidate records, none naming the thread; unknown manager, not absent',
      IDENTITY_SHAPE_CONFLICT: 'a row carrying both ids; Phase 8 owns its criterion',
      // HTTP-level responses from agent-routes.ts. These answer "your request was
      // wrong or too early", not "a service or file failed" — the matrix is about
      // the latter, which is what an operator diagnoses. Named here rather than
      // left invisible, which is what the previous collector did to them.
      CODEV_AGENT_STARTING: '503 while starting; a retry succeeds, distinct from UNREACHABLE',
      AGENT_ROUTE_NOT_FOUND: '404 for an unknown route; a client bug, not a failure mode',
      WORKSPACE_PATH_INVALID: '400 for an undecodable workspace path; malformed request',
      WORKSPACE_NOT_REGISTERED: '404 for a path this host does not serve; not a failure',
      HUMAN_SESSION_REQUIRED: 'no session presented; distinct from REVOKED, which is a matrix row',
      HUMAN_SESSION_RECOGNISED: 'the SUCCESS case, not a failure at all',
      PAIRING_ID_REQUIRED: 'argument validation thrown by completePairing',
      PAIRING_LIFETIME_INVALID: 'argument validation thrown by completePairing',
      PAIRING_PRINCIPAL_REFUSED: 'a non-human principal tried to pair; refusal, not a service failure',
      // Phase 11's two new routes. Both answer "your request was wrong, or it
      // worked", never "a service or file failed", so neither is a matrix row.
      HUMAN_SESSION_ISSUED: 'the SUCCESS case of human-session issuance',
      HUMAN_SESSION_REQUEST_MALFORMED: '400 for an unreadable body; malformed request',
      HUMAN_SESSION_REFUSED: 'completePairing rejected the attestation; a refusal, not a failure',
      GATE_APPROVED: 'the SUCCESS case of a gate approval',
      GATE_ALREADY_APPROVED: 'the gate was approved before this request; a success, not a failure',
      // Phase 11 round 3. Both answer "your request was wrong", not "a service
      // failed": one token presented to the wrong ceremony, one mint that named
      // no authority.
      PAIRING_TOKEN_WRONG_PURPOSE: 'a token minted for the other ceremony; a caller error',
      PAIRING_AUTHORITY_REQUIRED: 'argument validation thrown by issue()',
      // Stream event types, not signal codes. STATE_STREAM_WATCH_FAILED is both —
      // it carries a signal whose code equals the event type.
      // Spec 236 phase 4: approval operations. The three FAILURE states are matrix
      // rows; these are the successes and the refusals, which answer "your request
      // was wrong, or it worked" rather than "a service or file failed".
      APPROVAL_OPERATION_STORE_LOCKED: 'the store lock could not be taken; a retry succeeds, like APPROVAL_STORE_LOCKED',
      APPROVAL_OPERATION_ALREADY_SETTLED: 'a caller tried to change a settled record; a caller bug, distinct from UNKNOWN',
      APPROVAL_OPERATIONS_NOT_AVAILABLE: '501 from a host that wires no operation store; a capability statement, not a failure',
      APPROVAL_OPERATION_SUBMITTED: 'the SUCCESS case of submitting an approval',
      APPROVAL_OPERATION_SETTLED: 'an operation reached a terminal state; `state` says which, and none of them is a service failure',
      APPROVAL_ALREADY_IN_FLIGHT: 'a second submit for one project; a caller error, and it names the live one',
      APPROVAL_CONCURRENCY_LIMIT: 'a bound deliberately refusing work; not a failure of anything',
      // Spec 236 phase 3: `afx pair`. Operator-facing command outcomes, all of
      // them answering "your argument was wrong" or naming a store fault the
      // command already explains in full. None is a codev-agent service failure a
      // client renders, which is what the matrix is about.
      PAIR_PURPOSE_REQUIRED: 'argument validation; --purpose has no default by design',
      PAIR_PURPOSE_UNKNOWN: 'argument validation; the message names both valid values',
      PAIR_AUTHORITY_EMPTY: 'argument validation; an explicitly empty authority is refused',
      PAIR_TTL_INVALID: 'argument validation; a non-numeric --ttl-minutes',
      PAIR_MACHINE_REQUIRED: 'argument validation; revoke needs a name',
      PAIR_STORE_UNREADABLE: 'a CLI-side restatement of a store fault, for an operator at a terminal',
      PAIR_REVOKE_PARTIAL: 'the credential was revoked and the capability half was not; a partial outcome the command prints in full',
      PROTOCOL_STATE_SNAPSHOT: 'stream event type, not a failure signal',
      PROTOCOL_STATE_RECONCILED: 'stream event type; the repair is STREAM_PROJECTION_REPAIRED',
      STREAM_AUTHORIZATION_LOST: 'stream event type announcing WHY a stream closed; the code it carries (e.g. MACHINE_CREDENTIAL_REVOKED) is the matrix row',
      // STATE_STREAM_WATCH_FAILED was excluded here and that was my error, caught by
      // a reviewer: a watcher that cannot be established IS operator-facing, because
      // that root then depends entirely on the reconciliation backstop. It is now a
      // matrix row with its own test, so it is no longer in this list.
      // Matched, never emitted: these are node/sqlite error codes dbSignal reads.
      SQLITE_BUSY: 'sqlite error code matched by dbSignal, not a code we emit',
      SQLITE_LOCKED: 'sqlite error code matched by dbSignal, not a code we emit',
      // Spec 146 Phase 6 approval outcomes. Every one answers "this request was
      // refused", which is a per-request answer to a caller, not a service or
      // file failure an operator diagnoses. CAPABILITY_REVOKED is the exception
      // and IS a matrix row: it is the one where something that worked stops.
      APPROVAL_AUTHORIZED: 'the SUCCESS case, not a failure at all',
      APPROVAL_CAPABILITY_REQUIRED: 'nothing was presented; distinct from an invalid presentation',
      APPROVAL_CAPABILITY_MALFORMED: 'presentation is not <id>.<secret>; a client bug',
      APPROVAL_CAPABILITY_UNKNOWN: 'no such capability on this host; distinct from a wrong secret',
      APPROVAL_CAPABILITY_INVALID: 'wrong secret for a real capability id',
      APPROVAL_CAPABILITY_EXPIRED: 'past its expiry; sends an operator to the clock, not to reissue',
      APPROVAL_CAPABILITY_FOREIGN_MACHINE: 'issued for another machine; per-machine isolation working',
      APPROVAL_NONCE_MISSING: 'no nonce presented; distinct from one that is unknown',
      APPROVAL_NONCE_UNKNOWN: 'never minted here, or older than the nonce lifetime',
      APPROVAL_NONCE_REPLAYED: 'a consumed nonce presented again; the tombstone makes it distinct',
      APPROVAL_NONCE_EXPIRED: 'minted here but past its TTL',
      APPROVAL_NONCE_SCOPE_MISMATCH: 'bound to a different project/gate pair',
      APPROVAL_NONCE_CAPABILITY_MISMATCH: 'minted for a different capability than the one presented',
      APPROVAL_STORE_LOCKED: 'the store lock could not be taken; a retry succeeds, like CODEV_AGENT_STARTING',
      APPROVAL_STORE_UNREADABLE: 'the store exists but will not parse; distinct from "never issued", per-request not a service failure',
      CODEV_ARCHITECT_NAME: 'environment variable name read for caller attribution',
      APPROVAL_ISSUANCE_REFUSED_AGENT: 'caller declared itself a builder/architect; defence in depth',
      APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION: 'issuance without a paired human session',
      APPROVAL_REQUEST_MALFORMED: '400 for an unparseable or oversized approval body',
      // Env var names read by the porch approval path, not signals.
      CODEV_APPROVAL_CAPABILITY: 'environment variable name carrying the presentation',
      CODEV_APPROVAL_NONCE: 'environment variable name carrying the nonce',
      CODEV_WORKTREE_ROOT: 'environment variable name read for caller attribution',
      CODEV_BUILDER_ID: 'environment variable name read for caller attribution',
      // Spec 146 Phase 7 machine credentials. Every one is a per-request answer
      // to a caller: "this presentation is not one I can accept". They are not
      // service failures an operator diagnoses. MACHINE_CREDENTIAL_REVOKED is the
      // exception and IS a matrix row, for the same reason CAPABILITY_REVOKED is:
      // it is the one where something that used to work stops.
      MACHINE_CREDENTIAL_AUTHORIZED: 'the SUCCESS case, not a failure at all',
      MACHINE_CREDENTIAL_REQUIRED: 'nothing presented; distinct from an invalid presentation',
      MACHINE_CREDENTIAL_MALFORMED: 'presentation is not <id>.<secret>; a client bug',
      MACHINE_CREDENTIAL_UNKNOWN: 'no such credential on this host; distinct from a wrong secret',
      MACHINE_CREDENTIAL_INVALID: 'wrong secret for a real credential id',
      MACHINE_CREDENTIAL_EXPIRED: 'past its expiry; sends an operator to re-pair, not to un-revoke',
      MACHINE_CREDENTIAL_NOT_LIVE: 'revoking a machine that had nothing live; an answer, not a failure',
      MACHINE_NAME_REQUIRED: 'argument validation thrown by issue()',
      MACHINE_LIFETIME_INVALID: 'argument validation thrown by issue()',
      MACHINE_STORE_LOCKED: 'the store lock could not be taken; a retry succeeds, like APPROVAL_STORE_LOCKED',
      MACHINE_STORE_UNREADABLE: 'the store exists but will not parse; distinct from "never paired"',
      // Phase 7 pairing tokens. Same reasoning: per-request refusals.
      PAIRING_TOKEN_ACCEPTED: 'the SUCCESS case, not a failure at all',
      PAIRING_TOKEN_REQUIRED: 'no token presented; distinct from one that is unknown',
      PAIRING_TOKEN_MALFORMED: 'token is not <pairingId>.<secret>; a client bug',
      PAIRING_TOKEN_UNKNOWN: 'never minted here, or a wrong secret; deliberately the same answer',
      PAIRING_TOKEN_REDEEMED: 'a spent token presented again; the tombstone makes it distinct',
      PAIRING_TOKEN_EXPIRED: 'minted here but past its TTL',
      PAIRING_TTL_INVALID: 'argument validation thrown by issue()',
      PAIRING_REQUEST_MALFORMED: '400 for a redemption body with no machine name',
      PAIRING_STORE_LOCKED: 'the store lock could not be taken; a retry succeeds',
      PAIRING_STORE_UNREADABLE: 'the store exists but will not parse; distinct from "no such token"',
      PAIRING_CREDENTIAL_ISSUE_FAILED: 'the token was spent and issuance then failed; the answer says whether the token was released',
      AGENT_ROUTE_FAILED: 'last-resort 503 for a route body that threw; without it the throw exits Tower',
      // Phase 7 transport posture. Two are startup outcomes an operator reads in
      // the boot log, not failures reported to a caller; one is a per-request
      // refusal of a browser origin.
      ORIGIN_NOT_ALLOWED: '403 for a disallowed browser Origin; a per-request refusal',
      BIND_LOOPBACK_ONLY: 'the DEFAULT startup outcome, not a failure at all',
      BIND_EXPOSED_TLS_DECLARED: 'a startup outcome under an operator declaration',
      INSECURE_NON_LOOPBACK_BIND_REFUSED: 'a startup refusal; the process exits, so nothing is serving to diagnose',
      // Header names and env var names read by the Phase 7 auth path, not signals.
      AGENT_ROUTE_UNIMPLEMENTED: '501 for a table entry with no dispatcher case; a build-time slip, caught by a test',
      CODEV_BRIDGE_TLS: 'environment variable name declaring TLS termination',
      BRIDGE_MODE: 'environment variable name naming the exposure opt-in, not a signal',
      CODEV_AGENT_FARM_DIR: 'environment variable name for the test-isolation store root, not a signal',
    };

    // FIELD-AGNOSTIC ON PURPOSE, AND THE PREVIOUS VERSION WAS NOT.
    //
    // The first version of this collector matched `code:` and `failure('X')`, on the
    // assumption that emitted codes always appear under a `code` key. That
    // assumption was never checked, and it was wrong: `agent-routes.ts` emits under
    // `signal:` and `agent-state-stream.ts` emits one as a DEFAULT PARAMETER
    // (`code = 'STATE_STREAM_WATCH_FAILED'`). Six codes were invisible, so a test
    // written to catch "claims coverage it does not have" had exactly that flaw.
    // Two reviewers found it independently.
    //
    // Keying on the field name is the defect. This matches any SCREAMING_SNAKE
    // string literal, so a new emission under a new key name cannot hide. It
    // over-collects — SQLITE_BUSY and the stream's event types are not signals —
    // and over-collecting is the safe direction: the cost is one classification
    // line, versus a code shipping unnoticed.
    // Spec 146 Phase 6 added a sixth emitter OUTSIDE servers/. It is listed here
    // rather than left unscanned, because a code defined where the guard does not
    // look is exactly the hole this guard exists to close. Paths are relative to
    // servers/ so the rename check still fails by name.
    // Spec 146 Phase 7 added three more emitters — two outside servers/ — for the
    // same reason phase 6's addition is here: a code defined where the guard does
    // not look is exactly the hole this guard exists to close.
    const CODEV_AGENT_FILES = [
      'agent-routes.ts',
      'agent-state-stream.ts',
      'agent-failure.ts',
      'agent-auth.ts',
      'status-reader.ts',
      'thread-registry.ts',
      '../lib/approval-capability.ts',
      '../lib/machine-credentials.ts',
      '../lib/pairing.ts',
      // Spec 236. Added with the phases that introduced them, so their codes are
      // classified at the moment they exist rather than discovered later by
      // somebody reading the matrix and finding it short.
      '../lib/approval-operations.ts',
      '../commands/pair.ts',
    ];
    const serversDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const present = readdirSync(serversDir);
    const libPresent = readdirSync(join(serversDir, '..', 'lib'));
    const commandsPresent = readdirSync(join(serversDir, '..', 'commands'));
    // If a file is renamed away, fail rather than silently scanning less.
    for (const file of CODEV_AGENT_FILES) {
      if (file.startsWith('../lib/')) expect(libPresent).toContain(file.slice('../lib/'.length));
      else if (file.startsWith('../commands/')) {
        expect(commandsPresent).toContain(file.slice('../commands/'.length));
      } else expect(present).toContain(file);
    }

    // THE GUARD ASSERTS ITS OWN REACH.
    //
    // This has now been narrower than its own comment three times — single-quotes
    // only, keyed on `code:`, and (in porch's own checks) first-five-lines. Every
    // one was the same mistake: encoding an assumption about the thing being
    // scanned, and having no way to notice when the assumption stopped holding.
    //
    // Widening it a fourth time would not break that cycle. So it now measures
    // itself: EVERY scanned file must yield at least one code. A file that goes
    // quiet means the pattern has stopped matching that file's style, which is
    // exactly how the last three narrowings hid — silently, with the guard green.
    const perFile = new Map<string, number>();

    const emitted = new Set<string>();
    for (const file of CODEV_AGENT_FILES) {
      const source = readFileSync(join(serversDir, file), 'utf8');
      const fileCodes = new Set<string>();
      // Single-quoted AND template literals. Matching only `'...'` let
      // PAIRING_PRINCIPAL_REFUSED ship unclassified from a `throw new Error(\`...\`)`
      // — the third time this guard has been narrower than its own comment claimed.
      // The lesson is now in the shape of the pattern rather than in a promise: it
      // does not care which quote, which key, or which statement introduces a code.
      for (const literal of source.matchAll(/['`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/g)) {
        emitted.add(literal[1]);
        fileCodes.add(literal[1]);
      }
      perFile.set(file, fileCodes.size);
    }

    // EVERY file must yield codes. A file that goes quiet means the pattern stopped
    // matching its style — which is how all three previous narrowings hid.
    for (const file of CODEV_AGENT_FILES) {
      expect(perFile.get(file), `${file} yielded no codes; the collector has gone blind on it`)
        .toBeGreaterThan(0);
    }
    // The collector must not be silently empty — that would make this test vacuous.
    expect(emitted.size).toBeGreaterThan(15);
    // Anchors: one under `code:`, one under `signal:`, one a default parameter.
    // If the collector stops seeing any of these shapes, this test says so.
    expect(emitted).toContain('THREAD_UNMANAGED');
    expect(emitted).toContain('WORKSPACE_NOT_REGISTERED');
    expect(emitted).toContain('STATE_STREAM_WATCH_FAILED');

    const matrix = new Set<string>(Object.values(SIGNAL));
    const unclassified = [...emitted].filter((code) => !matrix.has(code) && !(code in NON_MATRIX)).sort();
    expect(unclassified).toEqual([]);
  });
});

describe('failure matrix', () => {
  it('codev-agent down emits CODEV_AGENT_UNREACHABLE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'unreachable',
      t3code: 'unreachable',
    });
    expect(failure.code).toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
  });

  // NAMED FOR THE PATH IT EXERCISES, not for the matrix row.
  //
  // This drives `readThreadRegistry` with an injected unreachable t3code — the
  // registry's own surfacing of that state. It is NOT the classifier, and while its
  // two sibling rows both call `classifyDualServiceFailure`, this one never did.
  // The row's classifier path is covered separately below.
  //
  // The old name, "codev-agent up but t3code down emits T3CODE_UNREACHABLE", read
  // as though the matrix row were pinned here. That drift between a test's name and
  // the code path it runs is the systematic weakness in this suite: it is how the
  // STATUS_UNREADABLE regression survived, and two independent reviewers landed on
  // instances of it. A name that overstates its reach is how coverage is believed
  // to exist where it does not.
  it('the registry surfaces an injected unreachable t3code as T3CODE_UNREACHABLE', () => {
    const snapshot = readThreadRegistry(db(), tmp(), [], {
      status: 'unreachable',
      message: 't3code connection refused',
    });
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain(SIGNAL.T3CODE_UNREACHABLE);
    // Assert against the whole list.  Finding the signal *by* its code and then
    // asserting that code is not some other code is a tautology that can never
    // fail, so it would not notice the two rows collapsing.
    expect(codes).not.toContain(SIGNAL.CODEV_AGENT_UNREACHABLE);
    expect(codes).not.toContain(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
  });

  // The row above exercises readThreadRegistry.  The client-facing classifier is
  // a second emitter of the same row and needs its own case, or its t3code
  // branch can return the agent-down code with the suite still green.
  it('the classifier maps agent-up/t3code-down to T3CODE_UNREACHABLE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'reachable',
      t3code: 'unreachable',
    });
    expect(failure.code).toBe(SIGNAL.T3CODE_UNREACHABLE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
  });

  it('the classifier refuses to invent a failure when both services are reachable', () => {
    expect(() => classifyDualServiceFailure({
      codevAgent: 'reachable',
      t3code: 'reachable',
    })).toThrow(/both services reachable/);
  });

  it('t3code up but codev-agent down emits CODEV_AGENT_UNREACHABLE_T3CODE_LIVE', () => {
    const failure = classifyDualServiceFailure({
      codevAgent: 'unreachable',
      t3code: 'reachable',
    });
    expect(failure.code).toBe(SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE);
    expect(failure.code).not.toBe(SIGNAL.CODEV_AGENT_UNREACHABLE);
  });

  it('a missing artifact root emits ROOT_MISSING, not an empty list', () => {
    const existing = tmp();
    expect(readStatusesFromArtifactRoot(existing)).toEqual([]);

    const gone = join(existing, 'deleted-worktree');
    const results = readStatusesFromArtifactRoot(gone);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0]?.ok) return;
    expect(results[0].signal.code).toBe(SIGNAL.ROOT_MISSING);
    expect(results[0].signal.code).not.toBe(SIGNAL.STATUS_UNREADABLE);
    expect(results[0].signal.code).not.toBe('STATUS_NOT_FOUND');

    const viaWorkspace = readWorkspaceStatuses(existing, [gone]);
    expect(viaWorkspace.some((result) => !result.ok && result.signal.code === SIGNAL.ROOT_MISSING)).toBe(true);
  });

  // TWO PATHS REACH STATUS_UNREADABLE, AND THEY MUST BOTH BE PINNED SEPARATELY.
  //
  // `readScopedStatus` maps EACCES/EPERM from reading the FILE;
  // `readStatusesFromArtifactRoot` maps it from reading the projects DIRECTORY.
  // A single test covering only the directory leaves the file branch free to
  // collapse into STATUS_MALFORMED — which tells an operator their file is corrupt
  // when it is a permissions problem. Different diagnosis, different fix.
  //
  // This was a coverage REGRESSION, not an original gap: the test once chmod'd the
  // status file and called `readScopedStatus`, and later refactors moved the target
  // to the directory while keeping the name. **A test that moves to a different code
  // path while keeping its name is worse than no test, because it reads as coverage.**
  // Hence two tests whose names say which path each one holds.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'an unreadable status.yaml FILE emits STATUS_UNREADABLE, not STATUS_MALFORMED',
    () => {
      const root = tmp();
      const statusPath = writeStatus(root, '1', porchYaml('1'));
      chmodSync(statusPath, 0o000);
      try {
        const result = readScopedStatus(root, statusPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.signal.code).toBe(SIGNAL.STATUS_UNREADABLE);
        // The collapse this test exists to prevent: a permissions failure reported
        // as a syntax failure.
        expect(result.signal.code).not.toBe(SIGNAL.STATUS_MALFORMED);
        expect(result.signal.code).not.toBe('STATUS_NOT_FOUND');
        // Names the file it could not read, so the operator knows which one.
        expect(result.signal.source).toBe(statusPath);
      } finally {
        chmodSync(statusPath, 0o644);
      }
    },
  );

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'an unreadable projects DIRECTORY emits STATUS_UNREADABLE, not an empty list',
    () => {
      const root = tmp();
      writeStatus(root, '1', porchYaml('1'));
      const projects = join(root, 'codev', 'projects');
      chmodSync(projects, 0o000);
      try {
        const results = readStatusesFromArtifactRoot(root);
        expect(results).toEqual([
          expect.objectContaining({
            ok: false,
            signal: expect.objectContaining({ code: SIGNAL.STATUS_UNREADABLE }),
          }),
        ]);
        // An unreadable directory is not "this workspace has no projects".
        expect(results).not.toEqual([]);
      } finally {
        chmodSync(projects, 0o755);
      }
    },
  );

  it('status.yaml malformed emits STATUS_MALFORMED', () => {
    const root = tmp();
    const statusPath = writeStatus(root, '2', 'this: [is: not: yaml\n');
    const result = readScopedStatus(root, statusPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.signal.code).toBe(SIGNAL.STATUS_MALFORMED);
    expect(result.signal.code).not.toBe(SIGNAL.STATUS_UNREADABLE);
    expect(result.signal.code).not.toBe('STATUS_NOT_FOUND');
  });

  it('a thread with no porch record emits THREAD_UNMANAGED and is not hidden', () => {
    const root = tmp();
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-1',
      worktree: join(root, '.builders', 'air-1'),
      threadId: 'thread-live',
    });
    const snapshot = readThreadRegistry(database, root, [], {
      status: 'available',
      threads: [{ threadId: 'thread-live' }],
    });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.THREAD_UNMANAGED);
    expect(snapshot.identities.some((row) => (
      row.threadId === 'thread-live' && row.management === 'unmanaged'
    ))).toBe(true);
    expect(snapshot.identities.find((row) => row.threadId === 'thread-live')).toBeDefined();
  });

  // The test above inserts a builder row, so `consumed` holds the thread and the
  // unmanaged loop never runs: its THREAD_UNMANAGED comes from the builder-row
  // path.  This covers the other emitting site -- a thread t3code reports that
  // Codev has no row for at all.  That is the one that can silently vanish.
  it('a t3code thread with no Codev row at all is surfaced as unmanaged, not hidden', () => {
    const root = tmp();
    const snapshot = readThreadRegistry(db(), root, [], {
      status: 'available',
      threads: [{ threadId: 'thread-stranger' }],
    });
    const unmanaged = snapshot.signals.filter((s) => s.code === SIGNAL.THREAD_UNMANAGED);
    expect(unmanaged).toHaveLength(1);
    expect(unmanaged[0]?.threadId).toBe('thread-stranger');
    expect(unmanaged[0]?.role).toBe('unmanaged');
    const identity = snapshot.identities.find((row) => row.threadId === 'thread-stranger');
    expect(identity).toBeDefined();
    expect(identity?.management).toBe('unmanaged');
    expect(snapshot.builders).toEqual({});
  });

  it('a porch record whose thread is gone emits PORCH_THREAD_NO_LONGER_EXISTS', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-2');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '3', porchYaml('3', 'thread_id: thread-gone'));
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-2',
      worktree,
      threadId: 'thread-gone',
    });
    const snapshot = readThreadRegistry(database, root, [status], {
      status: 'available',
      threads: [],
    });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.PORCH_THREAD_NO_LONGER_EXISTS);
    expect(snapshot.statuses.some((row) => row.projectId === '3')).toBe(true);
  });

  it('global.db locked emits GLOBAL_DB_LOCKED', () => {
    const locked = {
      prepare() {
        const error = new Error('database is locked') as Error & { code: string };
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    } as unknown as Database.Database;
    const snapshot = readThreadRegistry(locked, tmp(), []);
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.GLOBAL_DB_LOCKED);
    expect(snapshot.architects).toEqual({});
    expect(snapshot.builders).toEqual({});
  });

  // "Locked" is retryable and transient; any other DB fault is not. Collapsing
  // dbSignal to always report GLOBAL_DB_LOCKED left the whole suite green, so
  // this asserts the other side of that branch rather than only the lock side.
  it('a non-lock global.db error emits GLOBAL_DB_UNREADABLE, not GLOBAL_DB_LOCKED', () => {
    const corrupt = {
      prepare() {
        const error = new Error('database disk image is malformed') as Error & { code: string };
        error.code = 'SQLITE_CORRUPT';
        throw error;
      },
    } as unknown as Database.Database;
    const snapshot = readThreadRegistry(corrupt, tmp(), []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('GLOBAL_DB_UNREADABLE');
    expect(codes).not.toContain(SIGNAL.GLOBAL_DB_LOCKED);
  });

  // Two different remedies: "t3code lost the thread" versus "global.db has no
  // identity row for a porch record". t3code is available and still lists the
  // thread here, so PORCH_THREAD_NO_LONGER_EXISTS would be a false statement.
  it('a porch record with no global.db identity row emits PORCH_RECORD_UNMAPPED', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-5');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '11', porchYaml('11', 'thread_id: thread-orphan'));
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    // Deliberately no insertBuilder: the identity row is what is missing.
    const snapshot = readThreadRegistry(db(), root, [status], {
      status: 'available',
      threads: [{ threadId: 'thread-orphan' }],
    });
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('PORCH_RECORD_UNMAPPED');
    expect(codes).not.toContain(SIGNAL.PORCH_THREAD_NO_LONGER_EXISTS);
    expect(snapshot.signals.find((s) => s.code === 'PORCH_RECORD_UNMAPPED')?.projectId).toBe('11');
  });

  // Phase 8's "a row carrying both a terminal_id and a thread_id is rejected"
  // rests on this guard, so it is asserted here rather than inherited untested.
  it('a row carrying both terminal_id and thread_id emits IDENTITY_SHAPE_CONFLICT', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO builders (workspace_path, id, name, worktree, branch, terminal_id, thread_id)
      VALUES (?, 'air-6', 'air-6', ?, 'builder/test', 'term-1', 'thread-1')
    `).run(normalizeWorkspacePath(root), join(root, '.builders', 'air-6'));
    const snapshot = readThreadRegistry(database, root, []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('IDENTITY_SHAPE_CONFLICT');
    // The conflicted row must not be published as a usable join either way.
    expect(snapshot.builders).toEqual({});
    expect(snapshot.identities).toEqual([]);
  });

  // THE ARCHITECT BRANCH IS A SEPARATE CONDITION AND NEEDS ITS OWN TEST.
  //
  // The builder check above is `thread_id && terminal_id`. The architect check is
  // wider — `thread_id && (terminal_id || pid !== 0 || port !== 0 || cmd !== '')` —
  // so a thread-backed architect that still carries a pid, a port or a command is a
  // conflict even with no terminal_id. Only the builder branch was covered, and the
  // architect branch could be deleted with the suite green.
  //
  // It matters beyond coverage bookkeeping: **Phase 8's thread-backed architects are
  // exactly this shape** unless they zero those columns, so the branch that catches
  // a half-migrated row is the one nothing was testing.
  it('an architect row with a thread_id but a live pid emits IDENTITY_SHAPE_CONFLICT', () => {
    const root = tmp();
    const database = db();
    // No terminal_id at all — the builder-shaped check would not fire here.
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 4242, 0, '', NULL, 'thread-arch')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    const codes = snapshot.signals.map((s) => s.code);
    expect(codes).toContain('IDENTITY_SHAPE_CONFLICT');
    // Conflicted, so it is not published as a usable architect join.
    expect(snapshot.architects).toEqual({});
    expect(snapshot.identities).toEqual([]);
  });

  // A MULTI-PROJECT WORKTREE, WHICH IS THE ONLY KIND THIS REPO HAS.
  //
  // `statusForWorktree` used to resolve only when a worktree held exactly ONE
  // status.yaml. Real worktrees carry the whole codev/projects tree — 289 here — so
  // the join never resolved, every thread-backed builder was reported
  // THREAD_UNMANAGED, and THREAD_ID_DISAGREEMENT could never fire because it sits
  // behind a resolved record. The phase's reconciliation criterion was unreachable
  // in production while its tests passed.
  //
  // **Those tests passed because their fixtures shared the code's false premise.**
  // One project per worktree, exactly the shape that made the bug invisible. So
  // these use several, which is what production looks like.
  //
  // THE VERIFIED NUMBER, so a future fixture cannot quietly contradict it:
  // counted 2026-08-29, `ls -d codev/projects/*/` gives **302** in a real builder
  // worktree and 303 on main. Not "sometimes more than one" — never one, ever. The
  // old `matches.length === 1` join could not succeed in production at any point in
  // its life.
  //
  // **The rule, and it is more general than the bug:** when a fixture encodes a
  // claim about production shape, verify the claim against a real instance once and
  // put the number in the test. A comment said "a builder worktree normally owns one
  // project" and every fixture was built to agree with it. Counting the directories
  // takes one command and nobody ran it, because a fixture that agrees with the
  // assumption it should be challenging never fails.
  it('a multi-project worktree with no thread_id is AMBIGUOUS, not unmanaged', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-9');
    mkdirSync(worktree, { recursive: true });
    writeStatus(worktree, '20', porchYaml('20'));
    writeStatus(worktree, '21', porchYaml('21'));
    const database = db();
    insertBuilder(database, { workspace: root, id: 'air-9', worktree, threadId: 'thread-9' });

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    const codes = snapshot.signals.map((s) => s.code);
    // "Which record manages this" is unknown, which is NOT "nothing manages this".
    expect(codes).toContain('PORCH_JOIN_AMBIGUOUS');
    expect(codes).not.toContain(SIGNAL.THREAD_UNMANAGED);
  });

  // THE ACCEPTANCE CRITERION, IN THE SHAPE PRODUCTION ACTUALLY HAS.
  //
  // My first attempt at this test was named "disagreement then fires" and never
  // asserted the disagreement signal — it checked `management === 'managed'` and set
  // status.yaml's thread_id to MATCH the database, so there was no disagreement to
  // detect. A reviewer caught both. That is the name-versus-assertion drift for the
  // fourth time in this phase, mine again, in the fix for the previous one.
  //
  // It also exposed a real hole: keying the join on thread_id resolves only when the
  // two stores AGREE, which makes disagreement structurally undetectable in a
  // multi-project worktree. Identity now comes from the builder id, which stays true
  // while the stores differ.
  it('a multi-project worktree reports THREAD_ID_DISAGREEMENT when the stores differ', () => {
    const root = tmp();
    // Builder id `air-31` names project 31, independently of any thread.
    const worktree = join(root, '.builders', 'air-31');
    mkdirSync(worktree, { recursive: true });
    writeStatus(worktree, '30', porchYaml('30'));
    writeStatus(worktree, '31', porchYaml('31', 'thread_id: thread-porch-31'));
    writeStatus(worktree, '32', porchYaml('32'));
    const database = db();
    // The database says a DIFFERENT thread from status.yaml. This is the disagreement.
    insertBuilder(database, { workspace: root, id: 'air-31', worktree, threadId: 'thread-db-31' });

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    const codes = snapshot.signals.map((s) => s.code);

    expect(codes).toContain(SIGNAL.THREAD_ID_DISAGREEMENT);
    // Not ambiguous and not unmanaged: the record IS identified, it simply disagrees.
    expect(codes).not.toContain('PORCH_JOIN_AMBIGUOUS');
    expect(codes).not.toContain(SIGNAL.THREAD_UNMANAGED);
    expect(snapshot.identities[0]?.porch?.projectId).toBe('31');

    // Both values are reported, so a human can see which is which.
    const signal = snapshot.signals.find((s) => s.code === SIGNAL.THREAD_ID_DISAGREEMENT);
    expect(signal?.message).toContain('thread-porch-31');
    expect(signal?.message).toContain('thread-db-31');
  });

  // THE PADDING COLLISION IS REAL: 0120 (spir) and 120 (air) both exist on disk.
  it('a padded and an unpadded project with the same number both resolve to themselves', () => {
    for (const [builderId, expected] of [['builder-spir-120', '120'], ['builder-spir-0120', '0120']] as const) {
      const root = tmp();
      const worktree = join(root, '.builders', builderId);
      mkdirSync(worktree, { recursive: true });
      writeStatus(worktree, '120', porchYaml('120', 'thread_id: thread-porch'));
      writeStatus(worktree, '0120', porchYaml('0120', 'thread_id: thread-porch'));
      const database = db();
      insertBuilder(database, { workspace: root, id: builderId, worktree, threadId: 'thread-db' });

      const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
      // The exact digits win; the numerically-equal neighbour does not steal it.
      expect(snapshot.identities[0]?.porch?.projectId).toBe(expected);
    }
  });

  // THE SHAPE LIST IS READ OFF DISK, NOT TYPED.
  //
  // Two review lanes each found an id shape the other missed — a project named for a
  // `builder-`-prefixed id, and zero-padded ids with a live `0120`/`120` collision.
  // **Both were sitting in `codev/projects` the whole time.** Neither could have been
  // missed by a list generated from the directory, and both were missed by lists I
  // typed. A fixture list you write is a claim; one you read off the real store is a
  // fact.
  //
  // So this classifies every real project id and fails on any shape the resolver was
  // not built for. A new shape appearing on disk is what breaks it — which is the
  // only mechanism that does not depend on someone remembering to look.
  it('every porch id shape on disk is one the resolver handles', () => {
    const projectsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..', 'codev', 'projects');
    let entries: string[];
    try {
      entries = readdirSync(projectsDir);
    } catch {
      // Not running inside the repo (packaged install). Skipping is honest; silently
      // passing a completeness claim would not be.
      expect(true).toBe(true);
      return;
    }

    const ids: string[] = [];
    for (const entry of entries) {
      try {
        const body = readFileSync(join(projectsDir, entry, 'status.yaml'), 'utf8');
        const match = /^id:\s*'?([^'\n]+)'?\s*$/m.exec(body);
        if (match) ids.push(match[1].trim());
      } catch {
        // A project directory without a readable status.yaml is not an id shape.
      }
    }

    // The scan must not be vacuous — that is how a completeness claim goes hollow.
    expect(ids.length).toBeGreaterThan(50);

    const SHAPES: Array<[string, RegExp]> = [
      ['unpadded numeric', /^\d+$/],
      ['protocol-prefixed', /^[a-z]+-\d+$/],
      ['builder-prefixed', /^builder-[a-z0-9-]+$/],
    ];
    const unhandled = [...new Set(ids)].filter((id) => !SHAPES.some(([, re]) => re.test(id))).sort();
    expect(unhandled, `porch id shapes the resolver was not built for: ${unhandled.join(', ')}`).toEqual([]);

    // The collision that makes digit-matching unsafe is real, not hypothetical. If it
    // ever stops being real, the guard against it should be re-justified, not assumed.
    const padded = ids.filter((id) => /^0\d+$/.test(id));
    expect(padded.length).toBeGreaterThan(0);
    expect(ids).toContain('0120');
    expect(ids).toContain('120');
  });

  // A WRONG DIAGNOSIS IS WORSE THAN A MISSING ONE.
  //
  // PORCH_RECORD_UNMAPPED used to say "has no global.db identity row". A row can
  // exist and name a different thread, and that sentence sends an operator to create
  // a row instead of reconciling two that disagree — confidently, in the wrong
  // direction. This phase's rule is that signals must not overstate what they know,
  // and a message is part of the signal.
  it('PORCH_RECORD_UNMAPPED does not claim the identity row is absent', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-50');
    mkdirSync(worktree, { recursive: true });
    // A porch record naming a thread, with no builder row at all for it.
    writeStatus(worktree, '50', porchYaml('50', 'thread_id: thread-50'));
    const database = db();

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    const signal = snapshot.signals.find((s) => s.code === 'PORCH_RECORD_UNMAPPED');
    expect(signal).toBeDefined();
    // States what is known...
    expect(signal?.message).toContain('joined to no identity');
    // ...and does not assert the stronger thing it cannot see.
    expect(signal?.message).not.toContain('has no global.db identity row');
  });

  // THE REAL ID SHAPES, READ FROM REAL status.yaml FILES ON 2026-08-29.
  //
  //   spir-146   -> id: '146'        (trailing digits)
  //   air-173    -> id: '173'        (trailing digits)
  //   bugfix-102 -> id: bugfix-102   (the WHOLE builder id)
  //
  // The protocols genuinely differ and no single parse covers both. A first version
  // took only trailing digits and named `bugfix-174` in its comment as a worked
  // example of the rule holding — it does not. That claim was written as settled
  // without opening one of the three files that refute it, which is the same defect
  // as the 302-projects fixture, in the commit that introduced the rule against it.
  //
  // So the shapes are fixtures now, with the date. A future change cannot quietly
  // assume one rule without this failing.
  it.each([
    // Prefixed, because `builders.id` is prefixed in all 12 real rows.
    ['builder-spir-146', '146'],
    ['builder-air-173', '173'],
    ['builder-bugfix-102', 'bugfix-102'],
    // A project named for the PREFIXED id — real: builder-task-nhnj-task-NHnJ.
    ['builder-task-nhnj', 'builder-task-nhnj'],
  ])('builder %s resolves porch project %s in a multi-project worktree', (builderId, projectId) => {
    const root = tmp();
    const worktree = join(root, '.builders', builderId);
    mkdirSync(worktree, { recursive: true });
    writeStatus(worktree, projectId, porchYaml(projectId, 'thread_id: thread-porch'));
    // REAL DECOYS, from a collision that exists on disk: bugfix-799 and 799 are both
    // projects. The previous decoys were `decoy-1`/`decoy-2` under a comment claiming
    // they were "the digits the whole-id protocols must not be confused with" — they
    // were not, no record with the colliding id was written, and the fixture passed
    // under both correct and digits-first ordering. A guard that cannot fail is not a
    // guard, and the comment asserting otherwise was the worse half.
    if (projectId !== '799') writeStatus(worktree, '799', porchYaml('799'));
    if (projectId !== 'bugfix-799') writeStatus(worktree, 'bugfix-799', porchYaml('bugfix-799'));
    const database = db();
    insertBuilder(database, { workspace: root, id: builderId, worktree, threadId: 'thread-db' });

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    // Resolved by identity, so the stores can be compared and found to disagree.
    expect(snapshot.identities[0]?.porch?.projectId).toBe(projectId);
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.THREAD_ID_DISAGREEMENT);
    expect(snapshot.signals.map((s) => s.code)).not.toContain('PORCH_JOIN_AMBIGUOUS');
  });

  it('a multi-project worktree still resolves by thread_id when the id carries no project', () => {
    const root = tmp();
    // `task-uxln` names no project, so the thread is the only association left.
    const worktree = join(root, '.builders', 'task-uxln');
    mkdirSync(worktree, { recursive: true });
    writeStatus(worktree, '40', porchYaml('40'));
    writeStatus(worktree, '41', porchYaml('41', 'thread_id: thread-41'));
    const database = db();
    insertBuilder(database, { workspace: root, id: 'task-uxln', worktree, threadId: 'thread-41' });

    const snapshot = readThreadRegistry(database, root, readStatusesFromArtifactRoot(worktree));
    expect(snapshot.signals.map((s) => s.code)).not.toContain('PORCH_JOIN_AMBIGUOUS');
    expect(snapshot.identities[0]?.porch?.projectId).toBe('41');
  });

  // ISSUE #170 — a thread-backed architect keeps its `cmd`, and that is not a conflict.
  //
  // The detector counted a non-empty `cmd` as terminal-backed state, while Phase 8
  // writes `cmd` for thread-backed architects on purpose: it is NOT NULL in the
  // schema, it records how the architect was launched, and status rendering uses it.
  // So every thread-backed architect reported IDENTITY_SHAPE_CONFLICT forever — two
  // merged phases contradicting each other, latent only because no factory is
  // registered yet.
  //
  // This is the direction that was BROKEN, so it is the direction that needs its own
  // test: the honest sentinels are terminal_id NULL and pid/port 0, and a row with
  // those is clean no matter what `cmd` says.
  //
  // **DO NOT DELETE THIS AS REDUNDANT.** It asserts an absence, so it will look like
  // it tests nothing next to the two conflict tests below. It is the test holding the
  // narrowing in place: without it, re-adding `row.cmd !== ''` to the detector passes
  // the whole suite and every thread-backed architect silently becomes a conflict
  // again. A test that pins what must NOT happen is the only guard a narrowed
  // condition has.
  it('a thread-backed architect that kept its cmd is NOT a conflict', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 0, 0, 'claude --resume', NULL, 'thread-arch-ok')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    expect(snapshot.signals.map((s) => s.code)).not.toContain('IDENTITY_SHAPE_CONFLICT');
    // And it IS published, rather than being silently dropped as conflicted.
    expect(snapshot.architects).toEqual({ main: 'thread-arch-ok' });
  });

  // The narrowed condition must still fire on what it exists for: a row genuinely
  // half-migrated, carrying thread-backed and terminal-backed identity at once.
  // Narrowing a detector is only safe if the case it was built for is pinned.
  it('an architect row with a thread_id AND a terminal_id is still a conflict', () => {
    const root = tmp();
    const database = db();
    database.prepare(`
      INSERT INTO architect (workspace_path, id, pid, port, cmd, terminal_id, thread_id)
      VALUES (?, 'main', 0, 0, 'claude --resume', 'term-arch', 'thread-arch-half')
    `).run(normalizeWorkspacePath(root));
    const snapshot = readThreadRegistry(database, root, []);
    expect(snapshot.signals.map((s) => s.code)).toContain('IDENTITY_SHAPE_CONFLICT');
    expect(snapshot.architects).toEqual({});
  });

  // NAMED FOR THE HUMAN SESSION, NOT FOR A CAPABILITY.
  //
  // It presents a revoked human-session credential, which is the only revokeable
  // object phase 5 has. Capabilities are Phase 6's, and `CAPABILITY_REVOKED` will be
  // its own code. Calling this "a capability presented after revocation" claimed
  // coverage of a phase that has not been built — the same name-versus-path drift
  // that produced the STATUS_UNREADABLE regression, here pointing at a future phase
  // instead of a neighbouring function.
  // A WATCHER THAT CANNOT BE ESTABLISHED SAYS SO.
  //
  // I had excluded this code from the matrix as "not operator-facing". A reviewer
  // pushed back and was right: if `watch()` throws for a directory, that root's
  // changes reach the client only through the 5s reconciliation backstop. The stream
  // is DEGRADED, not broken — and degraded-but-silent is indistinguishable from
  // healthy, which is the thing this whole matrix exists to prevent.
  it('a watcher that cannot be established emits STATE_STREAM_WATCH_FAILED', () => {
    const root = tmp();
    writeStatus(root, '11', porchYaml('11'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    const throwingWatch = (() => {
      throw Object.assign(new Error('inotify limit reached'), { code: 'ENOSPC' });
    }) as unknown as typeof import('node:fs').watch;

    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      // No reconcile interval: this test is about the watch failure being announced,
      // not about the backstop that follows it.
      reconcileMs: 0,
      watchImpl: throwingWatch,
      snapshot: () => phaseSnapshot(root),
      onEvent: (event) => events.push(event),
    });
    try {
      const failed = events.filter((event) => event.type === 'STATE_STREAM_WATCH_FAILED');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]?.signal?.code).toBe(SIGNAL.STATE_STREAM_WATCH_FAILED);
      // Names the directory it could not watch, and why.
      expect(failed[0]?.signal?.message).toContain('inotify limit reached');
      // The initial snapshot still arrives: a failed WATCHER is not a failed STREAM,
      // and reporting it as one would be its own collapsed distinction.
      expect(events.some((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')).toBe(true);
    } finally {
      subscription.close();
    }
  });

  // A REVOKED CAPABILITY IS NOT AN EXPIRED ONE (Spec 146 Phase 6).
  //
  // Both stop an approval that used to work, and collapsing them sends an operator
  // to the wrong place: revoked means reissue, expired means the capability aged
  // out. The store is driven with a real issue → revoke → verify sequence rather
  // than a hand-built record, so the code being asserted is the one production
  // produces from its own storage.
  it('a revoked capability emits CAPABILITY_REVOKED, not an expiry or an invalid secret', () => {
    const root = tmp();
    const store = new ApprovalCapabilityStore({ root, machine: 'mac-studio' });
    const issued = store.issue({ sessionId: 'session-1' });
    expect(store.verify(issued.presentation).code).toBe(APPROVAL_SIGNAL.APPROVAL_AUTHORIZED);

    expect(store.revoke(issued.capabilityId)).toBe(true);
    const verdict = store.verify(issued.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(SIGNAL.CAPABILITY_REVOKED);
    // Assert against the neighbours it must not collapse into.
    expect(verdict.code).not.toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_EXPIRED);
    expect(verdict.code).not.toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_INVALID);
    expect(verdict.code).not.toBe(APPROVAL_SIGNAL.APPROVAL_CAPABILITY_UNKNOWN);
  });

  // MATRIX ROW, Spec 146 Phase 7. Its own row rather than a reuse of
  // CAPABILITY_REVOKED: that one says an approval credential was withdrawn, this
  // one says a whole machine's access was, and an operator chasing "why did the
  // iPad stop working" needs them to be different answers.
  it('a revoked MACHINE credential reports its own code, not the approval one', () => {
    const store = new MachineCredentialStore({ root: tmp() });
    const issued = store.issue({ machine: 'ipad' });
    expect(store.verify(issued.presentation).authorized).toBe(true);

    expect(store.revoke('ipad')).toBe(true);
    const verdict = store.verify(issued.presentation);
    expect(verdict.authorized).toBe(false);
    expect(verdict.code).toBe(SIGNAL.MACHINE_CREDENTIAL_REVOKED);
    // The three revocations must stay distinct from one another.
    expect(verdict.code).not.toBe(SIGNAL.CAPABILITY_REVOKED);
    expect(verdict.code).not.toBe(SIGNAL.HUMAN_SESSION_REVOKED);
  });

  // THE PLAN'S TEST PLAN ASKS FOR THESE TWO BY NAME.
  //
  // "Integration: ... a human-paired session recognised and an unpaired one refused."
  // Only the REVOKED path went through the HTTP route; the two the plan actually
  // names did not. I had recorded that as a known gap rather than a missing
  // requirement, which was the wrong call — a reviewer read the plan and said so.
  //
  // They matter as a pair. Phase 6 issues capabilities against a recognised session,
  // so "recognised" is the precondition its entire check rests on, and "refused"
  // is what stops an unpaired caller reaching that check at all.
  // The session is the "HUMAN-paired" session, so the refusal of a non-human
  // principal is the definition doing its work, not an argument check. Phase 6
  // issues capabilities against this; a builder or architect able to pair would
  // make "issuance is not reachable without a human-paired session" untrue.
  it('a non-human principal cannot pair', () => {
    const sessions = new HumanPairedSessionRegistry();
    for (const principalKind of ['builder', 'architect'] as const) {
      expect(() => sessions.completePairing({ pairingId: 'pair-x', principalKind }))
        .toThrow(/PAIRING_PRINCIPAL_REFUSED/);
    }
    // And the human path still works, so the refusal is not simply "everything fails".
    expect(sessions.completePairing({ pairingId: 'pair-y', principalKind: 'human-client' }).sessionId)
      .toBeTruthy();
  });

  // SPEC 146 PHASE 7 CHANGED THE PREMISE OF EVERY ROUTE TEST BELOW.
  //
  // The codev-agent surface now requires a machine credential on EVERY route, so
  // a request carrying only a human session is refused before it ever reaches the
  // session check. These tests are about the SESSION signals, so they now carry a
  // live machine credential and go on asserting exactly what they asserted
  // before. The behaviour changed by design; the checks did not stop finding
  // anything.
  //
  // The "no credential at all" case did not disappear. It moved to
  // `__tests__/agent-auth.test.ts`, which enumerates the router rather than
  // testing one route by hand.
  function pairedMachine(): { store: MachineCredentialStore; headers: Record<string, string> } {
    const store = new MachineCredentialStore({ root: tmp() });
    const issued = store.issue({ machine: 'matrix-test-machine' });
    return { store, headers: { [MACHINE_CREDENTIAL_HEADER]: issued.presentation } };
  }

  it('a paired human session is RECOGNISED through the route', () => {
    const sessions = new HumanPairedSessionRegistry();
    const machine = pairedMachine();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
      approvalCapabilities: new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' }),
      approvalNonces: new ApprovalNonceStore({ root: tmp() }),
      machineCredentials: machine.store,
      pairings: new PairingStore({ root: tmp() }),
    });
    const issued = sessions.completePairing({ pairingId: 'pair-ok', principalKind: 'human-client' });
    const out = fakeRes();
    const req = {
      method: 'GET',
      headers: { ...machine.headers, [HUMAN_SESSION_HEADER]: `${issued.sessionId}.${issued.credential}` },
    } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(req, out.res, new URL('http://localhost/api/agent/v1/session'));
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { signal?: string; paired?: boolean };
    // Success is spelled as success, not as an absent failure.
    expect(body.signal ?? 'HUMAN_SESSION_RECOGNISED').toBe('HUMAN_SESSION_RECOGNISED');
    expect(body.signal).not.toBe('HUMAN_SESSION_REQUIRED');
    expect(body.signal).not.toBe(SIGNAL.HUMAN_SESSION_REVOKED);
  });

  it('an unpaired caller is refused as REQUIRED, not as revoked', () => {
    const sessions = new HumanPairedSessionRegistry();
    const machine = pairedMachine();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
      approvalCapabilities: new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' }),
      approvalNonces: new ApprovalNonceStore({ root: tmp() }),
      machineCredentials: machine.store,
      pairings: new PairingStore({ root: tmp() }),
    });
    const out = fakeRes();
    // No session header — never paired, as distinct from paired-then-revoked. The
    // machine credential is present, so the refusal comes from the session check
    // and not from the machine check in front of it.
    const req = { method: 'GET', headers: { ...machine.headers } } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(req, out.res, new URL('http://localhost/api/agent/v1/session'));
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(401);
    const body = JSON.parse(out.body) as { signal: string; reason?: string };
    expect(body.signal).toBe('HUMAN_SESSION_REQUIRED');
    // Never-paired must not be reported as revoked: one says "authenticate", the
    // other says "your access was withdrawn", and they send an operator to
    // different places.
    expect(body.signal).not.toBe(SIGNAL.HUMAN_SESSION_REVOKED);
    expect(body.reason).not.toBe('REVOKED');
  });

  it('a revoked human-session credential is rejected as REVOKED, not as never-paired', () => {
    const sessions = new HumanPairedSessionRegistry();
    const machine = pairedMachine();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
      approvalCapabilities: new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' }),
      approvalNonces: new ApprovalNonceStore({ root: tmp() }),
      machineCredentials: machine.store,
      pairings: new PairingStore({ root: tmp() }),
    });
    const issued = sessions.completePairing({ pairingId: 'pair-1', principalKind: 'human-client' });
    const presentation = `${issued.sessionId}.${issued.credential}`;
    expect(sessions.revoke(issued.sessionId)).toBe(true);
    expect(sessions.recognize(presentation).reason).toBe('REVOKED');
    const out = fakeRes();
    const req = {
      method: 'GET',
      headers: { ...machine.headers, [HUMAN_SESSION_HEADER]: presentation },
    } as unknown as http.IncomingMessage;
    const handled = handleAgentRoute(
      req,
      out.res,
      new URL('http://localhost/api/agent/v1/session'),
    );
    expect(handled).toBe(true);
    const body = JSON.parse(out.body) as { signal: string; reason: string };
    expect(body.signal).toBe(SIGNAL.HUMAN_SESSION_REVOKED);
    expect(body.reason).toBe('REVOKED');
    expect(body.signal).not.toBe('HUMAN_SESSION_REQUIRED');
    expect(body.reason).not.toBe('UNKNOWN');
  });

  // ISSUANCE OVER THE ROUTE, Spec 146 Phase 6.
  //
  // These drive the real handler with a real body, because the deliverable is
  // about what a caller receives, not about what the issuing function does when
  // called directly. `fakeReq` is a readable that emits the body once.
  it('refuses capability issuance to a caller with no human-paired session', async () => {
    const sessions = new HumanPairedSessionRegistry();
    const machine = pairedMachine();
    const database = db();
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
      approvalCapabilities: new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' }),
      approvalNonces: new ApprovalNonceStore({ root: tmp() }),
      machineCredentials: machine.store,
      pairings: new PairingStore({ root: tmp() }),
    });
    const out = fakeRes();
    const handled = handleAgentRoute(
      fakeReq('POST', { ...machine.headers }, '{}'),
      out.res,
      new URL('http://localhost/api/agent/v1/approval-capabilities'),
    );
    expect(handled).toBe(true);
    await flush();
    expect(out.statusCode).toBe(401);
    expect((JSON.parse(out.body) as { signal: string }).signal).toBe('HUMAN_SESSION_REQUIRED');
  });

  it('issues to a paired session, and refuses a paired caller that declares itself a builder', async () => {
    const sessions = new HumanPairedSessionRegistry();
    const machine = pairedMachine();
    const database = db();
    const store = new ApprovalCapabilityStore({ root: tmp(), machine: 'test-machine' });
    initAgentRoutes({
      db: () => database,
      log: () => undefined,
      isKnownWorkspace: () => true,
      humanSessions: sessions,
      approvalCapabilities: store,
      approvalNonces: new ApprovalNonceStore({ root: tmp() }),
      machineCredentials: machine.store,
      pairings: new PairingStore({ root: tmp() }),
    });
    const issued = sessions.completePairing({ pairingId: 'pair-issue', principalKind: 'human-client' });
    const headers = { ...machine.headers, [HUMAN_SESSION_HEADER]: `${issued.sessionId}.${issued.credential}` };
    const url = new URL('http://localhost/api/agent/v1/approval-capabilities');

    const ok = fakeRes();
    handleAgentRoute(fakeReq('POST', headers, '{}'), ok.res, url);
    await flush();
    expect(ok.statusCode).toBe(201);
    const body = JSON.parse(ok.body) as { presentation: string; capabilityId: string };
    // The route returned something that actually verifies — otherwise a 201 with
    // a junk body would pass this test.
    expect(store.verify(body.presentation).authorized).toBe(true);

    // Same paired session, but declaring itself a builder. Defence in depth: a
    // caller that lies is NOT caught here, and the threat model says so.
    const refused = fakeRes();
    handleAgentRoute(
      fakeReq('POST', headers, JSON.stringify({ principalKind: 'builder' })),
      refused.res,
      url,
    );
    await flush();
    expect(refused.statusCode).toBe(403);
    expect((JSON.parse(refused.body) as { signal: string }).signal)
      .toBe(APPROVAL_SIGNAL.APPROVAL_ISSUANCE_REFUSED_AGENT);
  });

  it('a revoked session tombstone expires with the original lifetime', () => {
    let now = 1_000;
    const sessions = new HumanPairedSessionRegistry(() => now);
    const issued = sessions.completePairing({
      pairingId: 'pair-exp',
      principalKind: 'human-client',
      pairedAt: now,
      lifetimeMs: 1_000,
    });
    expect(sessions.revoke(issued.sessionId)).toBe(true);
    now = 2_001;
    expect(sessions.recognize(`${issued.sessionId}.${issued.credential}`).reason).toBe('UNKNOWN');
  });

  it('status.yaml versus thread disagreement emits THREAD_ID_DISAGREEMENT and does not resolve it', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-3');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '4', porchYaml('4', 'thread_id: thread-porch'));
    const before = readFileSync(statusPath, 'utf8');
    const status = readScopedStatus(worktree, statusPath);
    expect(status.ok).toBe(true);
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-3',
      worktree,
      threadId: 'thread-db',
    });
    const snapshot = readThreadRegistry(database, root, [status], { status: 'not-provided' });
    expect(snapshot.signals.map((s) => s.code)).toContain(SIGNAL.THREAD_ID_DISAGREEMENT);
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    const row = database.prepare(
      'SELECT thread_id FROM builders WHERE workspace_path = ? AND id = ?',
    ).get(normalizeWorkspacePath(root), 'air-3') as { thread_id: string };
    expect(row.thread_id).toBe('thread-db');
  });

  it('a missed watch event is repaired as STREAM_PROJECTION_REPAIRED, not a plain snapshot', async () => {
    const root = tmp();
    writeStatus(root, '8', porchYaml('8'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    let resolveRepair: (() => void) | undefined;
    const sawRepair = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no STREAM_PROJECTION_REPAIRED')), 1_000);
      resolveRepair = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      reconcileMs: 30,
      watchImpl: deafWatch as typeof import('node:fs').watch,
      snapshot: () => phaseSnapshot(root),
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'PROTOCOL_STATE_RECONCILED') resolveRepair?.();
      },
    });
    try {
      expect(events[0]?.type).toBe('PROTOCOL_STATE_SNAPSHOT');
      writeStatus(root, '8', porchYaml('8').replace('phase: implement', 'phase: review'));
      await sawRepair;
      const repaired = events.find((event) => event.type === 'PROTOCOL_STATE_RECONCILED');
      expect(repaired?.signal?.code).toBe(SIGNAL.STREAM_PROJECTION_REPAIRED);
      expect(repaired?.snapshot?.phase).toBe('review');
      expect(events.filter((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')).toHaveLength(1);
    } finally {
      subscription.close();
    }
  }, 5_000);

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'reconciler read failure emits STATUS_UNREADABLE, not no-changes',
    async () => {
      const root = tmp();
      writeStatus(root, '9', porchYaml('9'));
      const events: AgentStateStreamEvent<{ phase: string }>[] = [];
      let resolveUnreadable: (() => void) | undefined;
      const sawUnreadable = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('reconciler swallowed unreadable')), 1_000);
        resolveUnreadable = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      const subscription = watchAgentState({
        workspacePath: root,
        reconcileMs: 30,
        watchImpl: deafWatch as typeof import('node:fs').watch,
        snapshot: () => phaseSnapshot(root),
        onEvent: (event) => {
          events.push(event);
          if (event.signal?.code === SIGNAL.STATUS_UNREADABLE) resolveUnreadable?.();
        },
      });
      const projects = join(root, 'codev', 'projects');
      chmodSync(projects, 0o000);
      try {
        await sawUnreadable;
        expect(events.some((event) => event.signal?.code === SIGNAL.STATUS_UNREADABLE)).toBe(true);
      } finally {
        chmodSync(projects, 0o755);
        subscription.close();
      }
    },
  );
});

describe('acceptance extras', () => {
  it('serves a blocked gate structured question and choices, not just the gate name', () => {
    const root = tmp();
    const statusPath = writeStatus(root, '5', porchYaml('5', [
      '    requested_at: "2026-08-28T00:00:00.000Z"',
      '    request:',
      '      question: "Approve the plan?"',
      '      choices:',
      '        - label: yes',
      '          consequence: Plan proceeds',
      '        - label: no',
      '          consequence: Plan is rewritten',
    ].join('\n')));
    const result = readScopedStatus(root, statusPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const request = result.status.gates.pr.request;
    expect(request?.question).toBe('Approve the plan?');
    expect(request?.choices).toEqual([
      { label: 'yes', consequence: 'Plan proceeds' },
      { label: 'no', consequence: 'Plan is rewritten' },
    ]);
  });

  it('startup reconciliation reports THREAD_ID_DISAGREEMENT and does not write either store', () => {
    const root = tmp();
    const worktree = join(root, '.builders', 'air-4');
    mkdirSync(worktree, { recursive: true });
    const statusPath = writeStatus(worktree, '6', porchYaml('6', 'thread_id: thread-porch'));
    const before = readFileSync(statusPath, 'utf8');
    const database = db();
    insertBuilder(database, {
      workspace: root,
      id: 'air-4',
      worktree,
      threadId: 'thread-db',
    });
    const warnings: string[] = [];
    initAgentRoutes({
      db: () => database,
      log: (level, message) => {
        if (level === 'WARN') warnings.push(message);
      },
      isKnownWorkspace: () => true,
      humanSessions: new HumanPairedSessionRegistry(),
      machineCredentials: new MachineCredentialStore({ root: tmp() }),
      pairings: new PairingStore({ root: tmp() }),
    });
    expect(warnings.some((line) => line.includes(SIGNAL.THREAD_ID_DISAGREEMENT))).toBe(true);
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    const row = database.prepare(
      'SELECT thread_id FROM builders WHERE workspace_path = ? AND id = ?',
    ).get(normalizeWorkspacePath(root), 'air-4') as { thread_id: string };
    expect(row.thread_id).toBe('thread-db');
  });

  it('a connected watcher receives a porch state change without polling', async () => {
    const root = tmp();
    writeStatus(root, '7', porchYaml('7'));
    const events: AgentStateStreamEvent<{ phase: string }>[] = [];
    let resolveReview: (() => void) | undefined;
    const subscription = watchAgentState({
      workspacePath: root,
      debounceMs: 5,
      snapshot: () => {
        const results = readStatusesFromArtifactRoot(root);
        const ok = results.find((result) => result.ok);
        return {
          artifactRoots: [root],
          payload: { phase: ok && ok.ok ? ok.status.phase : 'missing' },
        };
      },
      onEvent: (event) => {
        events.push(event);
        if (event.snapshot?.phase === 'review') resolveReview?.();
      },
    });
    const sawReview = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const d = subscription.diagnostics;
        const phases = events
          .filter((event) => event.type === 'PROTOCOL_STATE_SNAPSHOT')
          .map((event) => event.snapshot?.phase);
        let code = 'UNKNOWN_MISS';
        if (events.some((event) => event.type === 'STATE_STREAM_WATCH_FAILED') || d.watchErrors > 0) {
          code = 'WATCH_FAILED';
        } else if (d.watchStarted === 0) {
          code = 'WATCHER_NEVER_ARMED';
        } else if (d.scheduleCalls === scheduledBeforeWrite) {
          code = 'WATCHER_NEVER_FIRED';
        } else if (d.snapshotCalls === snapshotsBeforeWrite) {
          code = 'SNAPSHOT_SWALLOWED';
        } else if (phases.includes('implement') && !phases.includes('review')) {
          code = 'SNAPSHOT_STALE';
        }
        reject(new Error(`${code} diagnostics=${JSON.stringify(d)} phases=${phases.join(',')}`));
      }, 30_000);
      resolveReview = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    let scheduledBeforeWrite = 0;
    let snapshotsBeforeWrite = 0;
    try {
      expect(events[0]?.type).toBe('PROTOCOL_STATE_SNAPSHOT');
      await new Promise<void>((resolve) => setImmediate(resolve));
      scheduledBeforeWrite = subscription.diagnostics.scheduleCalls;
      snapshotsBeforeWrite = subscription.diagnostics.snapshotCalls;
      const next = porchYaml('7').replace('phase: implement', 'phase: review');
      const statusPath = join(root, 'codev', 'projects', '7-proj', 'status.yaml');
      writeFileSync(`${statusPath}.tmp`, next);
      renameSync(`${statusPath}.tmp`, statusPath);
      await sawReview;
      expect(events.some((event) => event.snapshot?.phase === 'review')).toBe(true);
    } finally {
      subscription.close();
    }
  }, 35_000);
});

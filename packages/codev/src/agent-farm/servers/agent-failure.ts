/**
 * Distinct failure signals for codev-agent (Spec 146 Phase 5).
 *
 * An unreachable server, an empty result and a malformed file must never share
 * a code. When codev-agent is down it cannot emit, so the two "agent down"
 * rows are classified here from what the client observed.
 */

export const FAILURE_MATRIX_SIGNAL = {
  CODEV_AGENT_UNREACHABLE: 'CODEV_AGENT_UNREACHABLE',
  T3CODE_UNREACHABLE: 'T3CODE_UNREACHABLE',
  CODEV_AGENT_UNREACHABLE_T3CODE_LIVE: 'CODEV_AGENT_UNREACHABLE_T3CODE_LIVE',
  ROOT_MISSING: 'ROOT_MISSING',
  STATUS_UNREADABLE: 'STATUS_UNREADABLE',
  STATUS_MALFORMED: 'STATUS_MALFORMED',
  THREAD_UNMANAGED: 'THREAD_UNMANAGED',
  PORCH_THREAD_NO_LONGER_EXISTS: 'PORCH_THREAD_NO_LONGER_EXISTS',
  GLOBAL_DB_LOCKED: 'GLOBAL_DB_LOCKED',
  HUMAN_SESSION_REVOKED: 'HUMAN_SESSION_REVOKED',
  THREAD_ID_DISAGREEMENT: 'THREAD_ID_DISAGREEMENT',
  STREAM_PROJECTION_REPAIRED: 'STREAM_PROJECTION_REPAIRED',
  // Spec 146 Phase 6. Operator-facing and distinct from expiry on purpose: an
  // approval that used to work has stopped, and "revoked" sends the operator to
  // reissue while "expired" sends them to check the clock. The constant is
  // re-exported from lib/approval-capability.ts, which is where it is emitted.
  CAPABILITY_REVOKED: 'CAPABILITY_REVOKED',
  // Spec 146 Phase 7. Operator-facing and deliberately NOT CAPABILITY_REVOKED or
  // HUMAN_SESSION_REVOKED: those three answer different questions — this machine's
  // access was withdrawn, this approval credential was withdrawn, this browser
  // session was withdrawn — and send an operator to three different places. The
  // constant is emitted from lib/machine-credentials.ts.
  MACHINE_CREDENTIAL_REVOKED: 'MACHINE_CREDENTIAL_REVOKED',
  // A watcher could not be established on a directory. Operator-facing: that root's
  // changes now reach the client only via the reconciliation backstop, so the stream
  // is degraded rather than broken — and saying nothing would spell that as healthy.
  STATE_STREAM_WATCH_FAILED: 'STATE_STREAM_WATCH_FAILED',
  // Spec 146 Phase 12. The mailbox would not read, so no pane can show the
  // messages criterion 4 asks for. Operator-facing and its own row rather than
  // a reuse of GLOBAL_DB_LOCKED: this failure degrades ONE part of the snapshot
  // while every identity, status and gate on it stays current, and an operator
  // told the database is locked would go looking for a workspace that is in
  // fact fine. Emitted from servers/thread-registry.ts.
  MESSAGE_LOG_UNREADABLE: 'MESSAGE_LOG_UNREADABLE',
} as const;

export type FailureMatrixSignal =
  (typeof FAILURE_MATRIX_SIGNAL)[keyof typeof FAILURE_MATRIX_SIGNAL];

export type ServiceReachability = 'reachable' | 'unreachable';

export interface DualServiceFailure {
  readonly code:
    | typeof FAILURE_MATRIX_SIGNAL.CODEV_AGENT_UNREACHABLE
    | typeof FAILURE_MATRIX_SIGNAL.T3CODE_UNREACHABLE
    | typeof FAILURE_MATRIX_SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE;
  readonly message: string;
}

/**
 * Classify the three reachability combinations. "Both down" is
 * CODEV_AGENT_UNREACHABLE, never the t3code-live code: a partial answer
 * must not read as session-live-without-protocol.
 */
export function classifyDualServiceFailure(input: {
  readonly codevAgent: ServiceReachability;
  readonly t3code: ServiceReachability;
}): DualServiceFailure {
  if (input.codevAgent === 'unreachable' && input.t3code === 'reachable') {
    return {
      code: FAILURE_MATRIX_SIGNAL.CODEV_AGENT_UNREACHABLE_T3CODE_LIVE,
      message: 't3code is reachable but codev-agent is not; session state is live, protocol state is not',
    };
  }
  if (input.codevAgent === 'unreachable') {
    return {
      code: FAILURE_MATRIX_SIGNAL.CODEV_AGENT_UNREACHABLE,
      message: 'codev-agent is unreachable',
    };
  }
  if (input.t3code === 'unreachable') {
    return {
      code: FAILURE_MATRIX_SIGNAL.T3CODE_UNREACHABLE,
      message: 'codev-agent is up but t3code is unreachable',
    };
  }
  throw new Error('both services reachable; not a failure');
}

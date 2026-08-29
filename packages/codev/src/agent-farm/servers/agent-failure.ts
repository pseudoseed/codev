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
  STATUS_UNREADABLE: 'STATUS_UNREADABLE',
  STATUS_MALFORMED: 'STATUS_MALFORMED',
  THREAD_UNMANAGED: 'THREAD_UNMANAGED',
  PORCH_THREAD_NO_LONGER_EXISTS: 'PORCH_THREAD_NO_LONGER_EXISTS',
  GLOBAL_DB_LOCKED: 'GLOBAL_DB_LOCKED',
  HUMAN_SESSION_REVOKED: 'HUMAN_SESSION_REVOKED',
  THREAD_ID_DISAGREEMENT: 'THREAD_ID_DISAGREEMENT',
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

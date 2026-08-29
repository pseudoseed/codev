/**
 * What porch writes into `status.yaml` when a gate is approved, and the decision
 * that produces it (Spec 146 Phase 6).
 *
 * Success criterion 9b names the approving SESSION id specifically, and the
 * capability id is stored beside it because the two answer different questions:
 * which credential was used, and which human session used it. A capability that
 * outlives one browser session is presented by several sessions over its life.
 *
 * The record also names the authorization mode. `flag-only` is not a failure and
 * not a success — it is the honest statement that the approval carried no
 * capability, so nothing about who typed it is recorded. Leaving the field out
 * would spell "I could not tell" the same way as "a human did it".
 */

import {
  APPROVAL_SIGNAL,
  ApprovalCapabilityStore,
  ApprovalNonceStore,
  attributeApprovalCaller,
  CAPABILITY_ENV_VAR,
  NONCE_ENV_VAR,
  type ApprovalSignal,
} from '../../agent-farm/lib/approval-capability.js';

/**
 * Three ways a gate can reach `approved`, and the record names which. There is no
 * default: an approval with no mode recorded predates this phase and is unknown.
 *
 * - `capability`      — verified capability and single-use nonce.
 * - `flag-only`       — the flag, from a caller nothing attributed. Not a control.
 * - `pre-approved-artifact` — `approved:` frontmatter a human committed, consumed
 *   by `next.ts` without going through `approve()` at all.
 */
export type ApprovalMode = 'capability' | 'flag-only' | 'pre-approved-artifact';

export interface ApprovalRecord {
  /** `capability` means verified; `flag-only` means nothing about the caller is known. */
  authorization: ApprovalMode;
  approved_at: string;
  machine: string;
  /** What attribution actually read, verbatim. Never a conclusion about the caller. */
  caller: string;
  session_id?: string;
  capability_id?: string;
}

export type ApprovalDecision =
  | { readonly authorized: true; readonly record: ApprovalRecord }
  | { readonly authorized: false; readonly code: ApprovalSignal; readonly message: string };

export interface ApprovalAuthorizationInput {
  readonly projectId: string;
  readonly gateName: string;
  readonly artifactRoot: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capabilities: ApprovalCapabilityStore;
  readonly nonces: ApprovalNonceStore;
  readonly now?: () => Date;
}

/**
 * Decide whether this approval may proceed, and with what record.
 *
 * Three outcomes, and each is reachable:
 *
 * - A capability is presented → it is verified in full, nonce included. A failure
 *   here refuses the approval no matter who is asking, because a bad credential
 *   is a stronger signal than an absent one.
 * - No capability, and the caller is attributable to an agent session → refused.
 *   This is the shell-in-a-worktree path the spec names.
 * - No capability, and nothing attributes the caller → allowed, recorded as
 *   `flag-only`. This is deliberately not called a control anywhere.
 */
export function resolveApprovalAuthorization(input: ApprovalAuthorizationInput): ApprovalDecision {
  const now = input.now ?? (() => new Date());
  const attribution = attributeApprovalCaller({
    env: input.env,
    cwd: input.cwd,
    artifactRoot: input.artifactRoot,
  });
  const presentation = input.env[CAPABILITY_ENV_VAR]?.trim();

  if (!presentation) {
    if (attribution.kind === 'agent-session') {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_REQUIRED,
        message:
          `this approval is attributable to an agent session (${attribution.evidence}) ` +
          `and presented no approval capability in ${CAPABILITY_ENV_VAR}`,
      };
    }
    return {
      authorized: true,
      record: {
        authorization: 'flag-only',
        approved_at: now().toISOString(),
        machine: input.capabilities.machine,
        caller: attribution.evidence,
      },
    };
  }

  const verification = input.capabilities.verify(presentation);
  if (!verification.authorized) {
    return { authorized: false, code: verification.code, message: verification.message };
  }

  const consumption = input.nonces.consume(input.env[NONCE_ENV_VAR]?.trim(), {
    projectId: input.projectId,
    gateName: input.gateName,
  });
  if (!consumption.accepted) {
    return { authorized: false, code: consumption.code, message: consumption.message };
  }

  return {
    authorized: true,
    record: {
      authorization: 'capability',
      approved_at: now().toISOString(),
      machine: verification.machine ?? input.capabilities.machine,
      caller: attribution.evidence,
      session_id: verification.sessionId,
      capability_id: verification.capabilityId,
    },
  };
}

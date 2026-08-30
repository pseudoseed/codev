/**
 * What porch writes into `status.yaml` when a gate is approved, and the decision
 * that produces it (Spec 146 Phase 6).
 *
 * Success criterion 9b names the approving SESSION id specifically, and the
 * capability id is stored beside it because the two answer different questions:
 * which credential was used, and which session used it. A capability that
 * outlives one browser session is presented by several sessions over its life.
 *
 * The record also names the authorization mode. `flag-only` is not a failure and
 * not a success — it is the honest statement that the approval carried no
 * capability, so nothing about who typed it is recorded. Leaving the field out
 * would spell "I could not tell" the same way as "a human did it".
 *
 * ## `capability` MEANS VERIFIED CREDENTIAL, NOT VERIFIED HUMAN
 *
 * A capability is issued to a session paired with a single-use token minted on
 * this host. Minting one requires nothing but write access to the pairing store,
 * and every agent on this host runs as the same user — so a builder can mint a
 * token, redeem it, and approve its own gate through the advertised path.
 *
 * That is a real residual and it is stated rather than papered over. The record
 * therefore carries `authority`: what the minter said authorized the token, in
 * its own words, verbatim. A reader can see the claim an approval was made
 * under. What it must never do is read `authorization: 'capability'` as proof a
 * person was there.
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
  /**
   * `capability` means a verified credential and a spent single-use nonce. It
   * does NOT mean a human was verified — see the note above. `flag-only` means
   * nothing about the caller is known.
   */
  authorization: ApprovalMode;
  approved_at: string;
  machine: string;
  /** What attribution actually read, verbatim. Never a conclusion about the caller. */
  caller: string;
  session_id?: string;
  capability_id?: string;
  /**
   * What the pairing token behind this capability claimed authorized it, verbatim.
   *
   * Absent when the capability predates authorities, or on the `flag-only` path.
   * Absence means "not recorded", never "nothing authorized it".
   */
  authority?: string;
}

export type ApprovalDecision =
  | {
      readonly authorized: true;
      readonly record: ApprovalRecord;
      /**
       * Present only on the capability path. Called immediately before the gate
       * is written, so single-use is spent on an approval that actually happens.
       * `consume` — not `peek` — is the authoritative single-use step.
       */
      readonly consumeNonce?: () => { readonly accepted: boolean; readonly code: ApprovalSignal; readonly message: string };
    }
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
    // Only a BUILDER session is refused. An architect session is attributed and
    // recorded but allowed, because issuance is reachable only through the
    // client and refusing architects would leave no working approval path at
    // all. The threat model states that as a residual, not as a control.
    if (attribution.kind === 'builder-session') {
      return {
        authorized: false,
        code: APPROVAL_SIGNAL.APPROVAL_CAPABILITY_REQUIRED,
        message:
          `this approval is attributable to a builder session (${attribution.evidence}) ` +
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

  // PEEK, do not consume. This refusal happens before the phase checks run, so a
  // bad nonce fails in a second rather than after a full build — but consuming
  // here would burn a single-use nonce on a run that then fails a check or finds
  // the gate already approved, forcing a re-mint through the authenticated
  // route. `commitApprovalNonce` does the consuming, immediately before the write.
  const scope = {
    projectId: input.projectId,
    gateName: input.gateName,
    // Bound to the capability that just verified, so a nonce minted for one
    // capability cannot authorize an approval presented with another.
    capabilityId: verification.capabilityId ?? '',
  };
  const inspection = input.nonces.peek(input.env[NONCE_ENV_VAR]?.trim(), scope);
  if (!inspection.accepted) {
    return { authorized: false, code: inspection.code, message: inspection.message };
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
      ...(verification.authority ? { authority: verification.authority } : {}),
    },
    consumeNonce: () => input.nonces.consume(input.env[NONCE_ENV_VAR]?.trim(), scope),
  };
}

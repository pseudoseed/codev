/**
 * Porch - Protocol Orchestrator
 *
 * Claude calls porch as a tool; porch returns prescriptive instructions.
 * All commands produce clear, actionable output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import chalk from 'chalk';
import { globSync } from 'glob';
import type { ProjectState, Protocol, PlanPhase, CheckResult } from './types.js';
import { stalledRefreshes, unacknowledgedRefreshes } from './context-refresh.js';
import {
  readState,
  writeStateAndCommit,
  createInitialState,
  findStatusPath,
  projectNotFoundMessage,
  getArtifactRoot,
  getProjectDir,
  getStatusPath,
  detectProjectId,
  resolveProjectId,
  resolveArtifactBaseName,
  resolvePorchWorkspaceRoot,
  StateCommitFailed,
  StatePushFailed,
} from './state.js';
import {
  loadProtocol,
  getPhaseConfig,
  getNextPhase,
  getPhaseChecks,
  getPhaseGate,
  isPhased,
  isBuildVerify,
  getVerifyConfig,
} from './protocol.js';
import {
  findPlanFile,
  extractPlanPhases,
  getCurrentPlanPhase,
  getPhaseContent,
  allPlanPhasesComplete,
  isPlanPhaseComplete,
} from './plan.js';
import { getResolver, LocalResolver, type ArtifactResolver } from './artifacts.js';
import {
  runPhaseChecks,
  formatCheckResults,
  allChecksPassed,
  anyCheckBlocked,
  type CheckEnv,
} from './checks.js';
import { SUITE_LOCK_BUSY_EXIT } from '../../lib/suite-lock.js';
import { loadCheckOverrides, resolveConsultationModels } from './config.js';
import { findUnlandedCommits, completionReport } from './unlanded.js';
import { resolveDefaultBranch } from '../../lib/default-branch.js';

import { notifyGateApproved, notifyProtocolComplete } from './notify.js';
import type { ApprovalRecord } from './approval-record.js';
import { loadConfig } from '../../lib/config.js';
import { version } from '../../version.js';
import { readGateRequestFile } from './gate-request.js';
import { resolveApprovalAuthorization } from './approval-record.js';
import {
  ApprovalCapabilityStore,
  ApprovalNonceStore,
  CAPABILITY_ENV_VAR,
  NONCE_ENV_VAR,
} from '../../agent-farm/lib/approval-capability.js';

// ============================================================================
// Output Helpers
// ============================================================================

function header(text: string): string {
  const line = '═'.repeat(50);
  return `${line}\n  ${text}\n${line}`;
}

function section(title: string, content: string): string {
  return `\n${chalk.bold(title)}:\n${content}`;
}

/** Interior width of the CRITICAL RULES box, excluding the two `║` edges. */
const RULES_BOX_WIDTH = 62;

/**
 * Render the CRITICAL RULES box.
 *
 * The rules read as a numbered list and wrap at the box width, so a rule can be
 * a sentence instead of whatever fits in one hand-padded line. The old call
 * sites padded each line themselves, which capped every rule at what fit and is
 * why the box held only prohibitions.
 *
 * The first rule MUST be the affirmative one. A builder that reads a box whose
 * every line is a "do not" has been told what not to do and nothing to do, and
 * the safest-looking reading of that is to stop and ask. That misreading costs
 * hours per occurrence, so the box now opens by naming the work to start.
 */
function criticalRulesBox(rules: string[]): string {
  const edge = '═'.repeat(RULES_BOX_WIDTH);
  const lines: string[] = [`╔${edge}╗`, `║  🛑 CRITICAL RULES`.padEnd(RULES_BOX_WIDTH + 1) + '║'];

  rules.forEach((rule, i) => {
    // 2 leading spaces + "N. " marker; continuation lines align under the text.
    const marker = `${i + 1}. `;
    const indent = ' '.repeat(2 + marker.length);
    const avail = RULES_BOX_WIDTH - indent.length;
    // Hard-break anything wider than the box before wrapping. Phase ids come
    // from plan headings via `extractPlanPhases`, so a long slug is a single
    // unbreakable word — and a word wider than `avail` would otherwise run
    // straight through the border and break the frame it is rendered in.
    const words = rule.split(/\s+/).flatMap(w => {
      if (w.length <= avail) return [w];
      const parts: string[] = [];
      for (let k = 0; k < w.length; k += avail) parts.push(w.slice(k, k + avail));
      return parts;
    });
    const wrapped: string[] = [];
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > avail) {
        wrapped.push(cur);
        cur = w;
      } else {
        cur = cur ? `${cur} ${w}` : w;
      }
    }
    if (cur) wrapped.push(cur);
    wrapped.forEach((text, j) => {
      const prefix = j === 0 ? `  ${marker}` : indent;
      lines.push(`║${(prefix + text).padEnd(RULES_BOX_WIDTH)}║`);
    });
  });

  lines.push(`╚${edge}╝`);
  return lines.map(l => chalk.red.bold(l)).join('\n');
}

/**
 * The rules shown when porch hands a builder a plan phase.
 *
 * `currentPhaseId` is the phase to begin NOW; `nextPhaseId` is the one to stay
 * off until porch is run again. Keeping both named in the same box is the point
 * — the prohibition used to appear alone, and "DO NOT start the next phase"
 * with no next phase named reads as a general stop-and-wait.
 */
function phaseHandoffRules(
  projectId: string,
  currentPhaseId: string,
  nextPhaseId: string | undefined,
): string {
  return criticalRulesBox([
    `START ${currentPhaseId} NOW — a phase handoff is not a stopping point. Do not end your turn to report that you received it.`,
    nextPhaseId
      ? `DO NOT start ${nextPhaseId} until you run porch again!`
      : 'DO NOT start the next phase until you run porch again!',
    `When ${currentPhaseId} is complete, run: porch done ${projectId}`,
    'Stop only for a human gate, a blocker you cannot resolve, or a question whose answer changes the work.',
  ]);
}

/**
 * Return a resolver scoped to `artifactRoot` when it differs from the caller's
 * cwd-rooted resolver. The incoming `resolver` is typically built from
 * `process.cwd()` (the main workspace), but `findStatusPath` may resolve a
 * project to a builder worktree under `.builders/`. Checks like `plan_exists`
 * must read from that worktree, not from the main tree (bugfix #676).
 *
 * For the LOCAL backend we rebuild the resolver against `artifactRoot` so file
 * lookups point at `<artifactRoot>/codev/...`. For other backends (e.g. CLI)
 * artifact location is already independent of the filesystem, so we keep the
 * caller's resolver.
 */
function scopeResolver(
  workspaceRoot: string,
  artifactRoot: string,
  resolver?: ArtifactResolver,
): ArtifactResolver | undefined {
  if (artifactRoot === workspaceRoot) return resolver;
  // Only rebuild if the existing resolver is a LocalResolver (path-dependent).
  if (resolver && !(resolver instanceof LocalResolver)) return resolver;
  return getResolver(workspaceRoot, artifactRoot);
}

/**
 * Log override/skip notices before running checks.
 * Only emits output when overrides are actually in use.
 * @param phaseCheckNames - original check names from the protocol phase
 * @param resolvedChecks - checks after applying overrides (skipped ones absent)
 * @param overrides - raw override map from .codev/config.json (null if not configured)
 */
function logCheckOverrides(
  phaseCheckNames: string[],
  resolvedChecks: Record<string, import('./types.js').CheckDef>,
  overrides: import('./types.js').CheckOverrides | null
): void {
  if (!overrides) return;

  for (const name of phaseCheckNames) {
    const override = overrides[name];
    if (!override) continue;

    if (override.skip) {
      console.log(chalk.yellow(`  ⚠ Check "${name}" skipped (.codev/config.json)`));
    } else if (override.command || override.cwd || override.timeout !== undefined) {
      const parts: string[] = [];
      if (override.command) parts.push(resolvedChecks[name]?.command ?? override.command);
      if (override.cwd) parts.push(`cwd: ${override.cwd}`);
      // Issue #8: report the bound that was actually applied, not the one asked
      // for. A rejected value has already warned on stderr and left the default
      // in place, and this line must not then claim it took effect.
      const appliedMs = resolvedChecks[name]?.timeout_ms;
      if (appliedMs !== undefined) parts.push(`timeout: ${Math.round(appliedMs / 1000)}s`);
      if (parts.length > 0) {
        console.log(chalk.yellow(`  ⚠ Check "${name}" overridden: ${parts.join(', ')}`));
      }
    }
  }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * porch status <id> [--json]
 * Shows current state and prescriptive next steps.
 *
 * `--json`: emits a single-line JSON object with the project's current state
 * and gate status, suppressing all human-readable output. Consumed by the
 * VSCode Needs Attention view (Issue 691) and any other tooling that needs
 * structured access to gate state.
 *
 * JSON shape:
 *   {
 *     "id": string,
 *     "title": string,
 *     "protocol": string,
 *     "phase": string,
 *     "iteration": number,
 *     "build_complete": boolean,
 *     "gate": string | null,
 *     "gate_status": "pending" | "approved" | null,
 *     "gate_requested_at": string | null,   // ISO timestamp
 *     "gate_approved_at": string | null     // ISO timestamp
 *   }
 *
 * `--json` also carries the Spec 1470 refresh fields: `context_refreshes` (the
 * full history, each with `boundary`, `at`, and `acknowledged_at` once a builder
 * has returned), `unacknowledged_refreshes` (the raw fact, any age), and
 * `stalled_refreshes` (only those past the grace period, each with `ageMs`).
 * Fields are ADDED; nothing pre-existing is removed or retyped.
 */
export async function status(
  workspaceRoot: string,
  projectId: string,
  resolver?: ArtifactResolver,
  options?: { json?: boolean },
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    const msg = projectNotFoundMessage(workspaceRoot, projectId);
    if (options?.json) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);

  if (options?.json) {
    const gateName = getPhaseGate(protocol, state.phase);
    const gateStatus = gateName ? state.gates[gateName] : undefined;
    const out = {
      id: state.id,
      title: state.title,
      protocol: state.protocol,
      phase: state.phase,
      iteration: state.iteration,
      build_complete: state.build_complete,
      gate: gateName ?? null,
      gate_status: gateStatus?.status ?? null,
      gate_requested_at: gateStatus?.requested_at ?? null,
      gate_approved_at: gateStatus?.approved_at ?? null,
      // Spec 1470. Fields ADDED, none removed or retyped, so existing consumers
      // (dashboard, VS Code tree) keep parsing unchanged.
      context_refreshes: state.context_refreshes ?? [],
      unacknowledged_refreshes: unacknowledgedRefreshes(state),
      stalled_refreshes: stalledRefreshes(state, Date.now()),
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  // Header
  console.log('');
  console.log(header(`PROJECT: ${state.id} - ${state.title}`));
  console.log(`  PROTOCOL: ${state.protocol}`);
  console.log(`  PHASE: ${state.phase} (${phaseConfig?.name || 'unknown'})`);

  // For phased protocols, show plan phase status
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    console.log('');
    console.log(chalk.bold('PLAN PHASES:'));
    console.log('');

    // Status icons
    const icon = (status: string) => {
      switch (status) {
        case 'verified': return chalk.green('✓');
        case 'complete': return chalk.green('✓'); // backward compat
        case 'in_progress': return chalk.yellow('►');
        default: return chalk.gray('○');
      }
    };

    // Show phases
    for (const phase of state.plan_phases) {
      const isCurrent = phase.status === 'in_progress';
      const prefix = isCurrent ? chalk.cyan('→ ') : '  ';
      const title = isCurrent ? chalk.bold(phase.title) : phase.title;

      console.log(`${prefix}${icon(phase.status)} ${phase.id}: ${title}`);
    }
  }

  // Context refreshes (Spec 1470). Shown for any protocol that has them, not
  // only phased ones — a boundary can fire on entering `plan` too.
  const refreshes = state.context_refreshes ?? [];
  if (refreshes.length > 0) {
    const stalled = stalledRefreshes(state, Date.now());
    console.log('');
    console.log(chalk.bold('CONTEXT REFRESHES:'));
    console.log('');
    for (const r of refreshes) {
      const done = r.acknowledged_at !== undefined;
      const isStalled = stalled.some(sr => sr.boundary === r.boundary);
      // Three states, not two: acknowledged, in flight, and stalled. Marking an
      // in-flight refresh as a fault would cry wolf on every healthy one.
      const mark = done ? chalk.green('✓') : isStalled ? chalk.yellow('!') : chalk.cyan('…');
      const when = done
        ? ''
        : isStalled
          ? chalk.yellow('  ← no builder has returned since')
          : chalk.cyan('  ← refresh in flight');
      console.log(`  ${mark} ${r.boundary}  ${chalk.gray(r.at)}${when}`);
    }

    if (stalled.length > 0) {
      // The unattended failure this whole field exists to surface: the builder
      // cleared and nothing came back. Say what to do, because the person
      // reading this is not necessarily the person who built the feature.
      console.log('');
      console.log(
        chalk.yellow(
          `  ⚠ ${stalled.length} refresh(es) recorded but never acknowledged. A builder that ` +
            `cleared and did not return looks idle, not broken.`,
        ),
      );
      console.log(
        chalk.gray('    Recover with:  ') +
          `afx send <builder> "Read .builder-reorient.md, then run porch next"`,
      );
    }
  }

  {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase) {
      console.log('');
      console.log(chalk.bold(`CURRENT: ${currentPlanPhase.id} - ${currentPlanPhase.title}`));

      // Show phase content from plan (via resolver if available)
      const planContent = resolver?.getPlanContent(state.id, state.title)
        ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
      if (planContent) {
        const phaseContent = getPhaseContent(planContent, currentPlanPhase.id);
        if (phaseContent) {
          console.log(section('FROM THE PLAN', phaseContent.slice(0, 500)));
        }
      }

      // Find the next phase name for the warning
      const currentIdx = state.plan_phases.findIndex(p => p.id === currentPlanPhase.id);
      const nextPlanPhase = state.plan_phases[currentIdx + 1];

      console.log('');
      console.log(phaseHandoffRules(state.id, currentPlanPhase.id, nextPlanPhase?.id));
    }
  }

  // Show checks status (apply overrides so display matches what will actually run)
  const statusOverrides = loadCheckOverrides(workspaceRoot, state.protocol);
  const checks = getPhaseChecks(protocol, state.phase, statusOverrides ?? undefined, workspaceRoot);
  if (Object.keys(checks).length > 0) {
    const checkLines = Object.keys(checks).map(name => `  ○ ${name} (not yet run)`);
    console.log(section('CRITERIA', checkLines.join('\n')));
  }

  // Instructions
  const gate = getPhaseGate(protocol, state.phase);
  if (gate && state.gates[gate]?.status === 'pending' && state.gates[gate]?.requested_at) {
    console.log(section('STATUS', chalk.yellow('WAITING FOR HUMAN APPROVAL')));
    console.log(`\n  Gate: ${gate}`);
    console.log('  Do not proceed until gate is approved.');
    console.log(`\n  To approve: porch approve ${state.id} ${gate}`);
  } else {
    console.log(section('INSTRUCTIONS', getInstructions(state, protocol)));
  }

  console.log(section('NEXT ACTION', getNextAction(state, protocol)));
  console.log('');
}

function exitChecksNotPassed(results: CheckResult[], cannot: string): never {
  console.log('');
  if (anyCheckBlocked(results)) {
    console.log(chalk.yellow(`CHECKS BLOCKED. ${cannot}`));
    console.log('\n  Another Vitest run holds the suite lock. Retry when it finishes.');
    process.exit(SUITE_LOCK_BUSY_EXIT);
    throw new Error('unreachable');
  }
  console.log(chalk.red(`CHECKS FAILED. ${cannot}`));
  console.log('\n  Fix the failures and try again.');
  process.exit(1);
  throw new Error('unreachable');
}

/**
 * porch check <id>
 * Runs the phase checks and reports results.
 */
export async function check(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(projectNotFoundMessage(workspaceRoot, projectId));
  }

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml.
  // `findStatusPath` searches `.builders/*` first; resolver/cwd must match so
  // checks like `plan_exists` see files in the same worktree (bugfix #676).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined, workspaceRoot);

  if (Object.keys(checks).length === 0 && phaseCheckNames.length === 0) {
    console.log(chalk.dim('No checks defined for this phase.'));
    return;
  }

  const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

  console.log('');
  console.log(chalk.bold('RUNNING CHECKS...'));
  logCheckOverrides(phaseCheckNames, checks, overrides);
  console.log('');

  if (Object.keys(checks).length === 0) {
    console.log(chalk.dim('  (all checks skipped via .codev/config.json)'));
    console.log('');
    console.log(chalk.green('RESULT: ALL CHECKS PASSED'));
    console.log(`\n  Run: porch done ${state.id} (to advance)`);
    console.log('');
    return;
  }

  const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
  console.log(formatCheckResults(results));

  console.log('');
  if (allChecksPassed(results)) {
    console.log(chalk.green('RESULT: ALL CHECKS PASSED'));
    console.log(`\n  Run: porch done ${state.id} (to advance)`);
  } else if (anyCheckBlocked(results)) {
    console.log(chalk.yellow('RESULT: CHECKS BLOCKED'));
    console.log('\n  Another Vitest run holds the suite lock. Retry when it finishes.');
  } else {
    console.log(chalk.red('RESULT: CHECKS FAILED'));
    console.log(`\n  Fix the failures and run: porch check ${state.id}`);
  }
  console.log('');
}

/**
 * porch done <id>
 * Advances to next phase if checks pass. Refuses if checks fail.
 */
export async function done(workspaceRoot: string, projectId: string, resolver?: ArtifactResolver, options?: { pr?: number; branch?: string; merged?: number }): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(projectNotFoundMessage(workspaceRoot, projectId));
  }

  let state = readState(statusPath);

  // Record-only mode: --pr or --merged writes PR metadata and exits immediately.
  // Does NOT run checks, does NOT advance the phase, does NOT mark build_complete.
  if (options?.pr !== undefined) {
    if (!options.branch) throw new Error('--pr requires --branch <name>');
    if (!state.pr_history) state.pr_history = [];
    state.pr_history.push({
      phase: state.phase,
      pr_number: options.pr,
      branch: options.branch,
      created_at: new Date().toISOString(),
    });
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} record PR #${options.pr}`);
    console.log(chalk.green(`Recorded PR #${options.pr} (branch: ${options.branch}) in pr_history.`));
    return;
  }
  if (options?.merged !== undefined) {
    if (!state.pr_history) throw new Error(`No PR history found for project ${projectId}`);
    const entry = state.pr_history.find(e => e.pr_number === options.merged);
    if (!entry) throw new Error(`PR #${options.merged} not found in pr_history`);
    entry.merged = true;
    entry.merged_at = new Date().toISOString();
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} PR #${options.merged} merged`);
    console.log(chalk.green(`Marked PR #${options.merged} as merged.`));
    return;
  }

  // Idempotency for terminal state: re-running `porch done` on an already-verified
  // project must be a silent no-op, not a fresh state write + commit (#903).
  if (state.phase === 'verified') {
    console.log(chalk.dim(`Project ${state.id} already verified — nothing to do.`));
    return;
  }

  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const overrides = loadCheckOverrides(workspaceRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined, workspaceRoot);

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml
  // (bugfix #676 — see check() for rationale).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

  // Run checks first — but skip if the gate was just approved (approve already ran them)
  if (phaseCheckNames.length > 0) {
    const gate = getPhaseGate(protocol, state.phase);
    const gateStatus = gate ? state.gates[gate] : undefined;
    const recentlyApproved = gateStatus?.status === 'approved' && gateStatus.approved_at &&
      (Date.now() - new Date(gateStatus.approved_at).getTime()) < 60_000;

    if (recentlyApproved) {
      console.log('');
      console.log(chalk.dim('Checks skipped (gate approved <60s ago).'));
    } else {
      const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

      console.log('');
      console.log(chalk.bold('RUNNING CHECKS...'));
      logCheckOverrides(phaseCheckNames, checks, overrides);

      if (Object.keys(checks).length > 0) {
        const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
        console.log(formatCheckResults(results));

        if (!allChecksPassed(results)) {
          exitChecksNotPassed(results, 'Cannot advance.');
        }
      } else {
        console.log(chalk.dim('  (all checks skipped via .codev/config.json)'));
      }
    }
  }

  // For build_verify phases: mark build as complete for verification
  if (isBuildVerify(protocol, state.phase) && !state.build_complete) {
    state.build_complete = true;
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${state.phase} build-complete`);
    console.log('');
    console.log(chalk.green('BUILD COMPLETE. Ready for verification.'));
    console.log(`\n  Run: porch next ${state.id} (to get verification tasks)`);
    return;
  }

  // Enforce verification for build_verify phases (config-aware)
  const verifyConfig = getVerifyConfig(protocol, state.phase);
  if (verifyConfig) {
    // Resolve effective models through the SAME resolver `porch next` uses, so the lanes demanded
    // here are exactly the lanes that were emitted. The former local copy silently disagreed with
    // `next` on single-string values and on invalid lane names.
    //
    // The `catch` that used to wrap this is deliberately gone. Swallowing a config error and
    // continuing on protocol defaults meant a typo in `porch.consultation` changed which lanes
    // porch required without saying so — `next` would refuse to run while `done` quietly demanded
    // a different set. Config errors now surface here as they already did in `next`. This is a
    // real behavior change: a workspace whose config is malformed today limps along on protocol
    // defaults and will now fail loudly.
    const { models: effectiveModels, mode: consultMode } = resolveConsultationModels(
      workspaceRoot, verifyConfig.models, state.protocol, verifyConfig.type
    );

    // "none" mode: skip verification
    if (consultMode === 'none') {
      console.log(chalk.dim('  (consultation skipped — configured: none)'));
    } else if (consultMode === 'parent') {
      // "parent" mode: verification is handled by architect gate, not review files
      console.log(chalk.dim('  (consultation delegated to architect — configured: parent)'));
    } else {
      // Normal mode: check for review files from effective models
      const projectDir = getProjectDir(workspaceRoot, state.id, state.title);
      const phase = state.current_plan_phase || state.phase;
      const missingModels: string[] = [];

      for (const model of effectiveModels) {
        // Look for any review file for this model+phase (any iteration)
        const pattern = path.join(projectDir, `${state.id}-${phase}-iter*-${model}.txt`);
        const matches = globSync(pattern);
        if (matches.length === 0) {
          missingModels.push(model);
        }
      }

      if (missingModels.length > 0) {
        console.log('');
        console.log(chalk.red('VERIFICATION REQUIRED'));
        console.log(`\n  ${effectiveModels.length}-way review not completed. Missing: ${missingModels.join(', ')}`);
        console.log(`\n  Run: porch next ${state.id} (to trigger verification)`);
        process.exit(1);
      }
    }
  }

  // Check for gate — auto-request if not yet requested
  const gate = getPhaseGate(protocol, state.phase);
  if (gate && state.gates[gate]?.status !== 'approved') {
    // Auto-request the gate if it hasn't been requested yet
    if (!state.gates[gate]) {
      state.gates[gate] = { status: 'pending' };
    }
    if (!state.gates[gate].requested_at) {
      state.gates[gate].requested_at = new Date().toISOString();
      // Issue #872: AIR / BUGFIX pr (once-phase, gate=pr) reaches the human-review
      // bottleneck here — done auto-requests the `pr` gate. Set the canonical
      // pr-ready signal in the same write so consumers don't have to wait for
      // a subsequent state mutation to learn the PR is ready for a reviewer.
      if (gate === 'pr') {
        state.pr_ready_for_human = true;
      }
      await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gate} gate-requested`);
    }
    console.log('');
    console.log(chalk.yellow(`GATE REQUIRED: ${gate}`));
    console.log(`\n  Run: porch gate ${state.id}`);
    console.log('  Wait for human approval before advancing.');
    return;
  }

  // For phased protocols: plan phase advancement requires multi-lane review.
  // The isBuildVerify block above already marked build_complete=true.
  // Redirect to porch next for verification (lane review + unanimous verdict).
  if (isPhased(protocol, state.phase) && state.plan_phases.length > 0) {
    const currentPlanPhase = getCurrentPlanPhase(state.plan_phases);
    if (currentPlanPhase && !allPlanPhasesComplete(state.plan_phases)) {
      // Say how many lanes will actually run. "3-way" was hardcoded, which stopped being true the
      // moment config could select lanes — a workspace running a 2-lane PIR was told to expect a
      // 3-way review and had no way to tell whether the third had failed or was never asked for.
      const laneCount = verifyConfig
        ? resolveConsultationModels(workspaceRoot, verifyConfig.models, state.protocol, verifyConfig.type).models.length
        : 0;
      console.log('');
      console.log(chalk.green(
        laneCount > 0 ? `BUILD COMPLETE. Ready for ${laneCount}-way review.` : 'BUILD COMPLETE. Ready for review.'
      ));
      console.log(`\n  Run: porch next ${state.id} (to trigger verification)`);
      return;
    }
  }

  // Advance to next protocol phase
  await advanceProtocolPhase(workspaceRoot, state, protocol, statusPath, scopedResolver);
}

/**
 * The completion banner, told the truth (issue #57).
 *
 * `porch done` writes state commits AFTER the PR it was tracking has merged, so
 * the branch is ahead of its base at the exact moment porch says the protocol
 * is complete. Observed on a BUGFIX run: two porch commits stranded on the
 * builder branch, banner clean.
 *
 * That signal is what a builder stops on. One that trusted it stopped with work
 * unlanded; one that did not trust it improvised a second PR that no phase
 * owned, no gate covered, and no notification was attached to -- so the
 * architect was never told anyone was waiting, and the worktree sat idle with
 * nothing reporting a problem.
 *
 * Three outcomes, three renderings. "Could not check" is NOT folded into
 * "clean": they lead to opposite actions.
 */
function reportCompletion(workspaceRoot: string, state: ProjectState): void {
  const base = resolveDefaultBranch(workspaceRoot);
  const landing = findUnlandedCommits(workspaceRoot, base);
  const { severity, lines } = completionReport(state.id, state.protocol, base, landing);

  const paint = severity === 'complete' ? chalk.green.bold : chalk.yellow.bold;
  console.log(paint(lines[0]));
  for (const line of lines.slice(1)) {
    console.log(/^\s{4}(git |afx )/.test(line) ? chalk.cyan(line) : line);
  }
}

async function advanceProtocolPhase(workspaceRoot: string, state: ProjectState, protocol: Protocol, statusPath: string, resolver?: ArtifactResolver): Promise<void> {
  const nextPhase = getNextPhase(protocol, state.phase);

  if (!nextPhase) {
    state.phase = 'verified';
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} protocol complete`);
    notifyProtocolComplete(getArtifactRoot(statusPath), state.id);
    console.log('');
    // Issue #57: the check runs AFTER that commit, deliberately. That commit is
    // itself one of the unlanded ones -- along with the `PR #N merged` commit
    // that `done --merged` wrote after the PR closed -- and the whole point is
    // that the banner has been printing over the top of them.
    reportCompletion(workspaceRoot, state);
    return;
  }

  state.phase = nextPhase.id;
  state.build_complete = false;
  state.iteration = 1;

  // If entering a phased phase (implement), extract plan phases
  if (isPhased(protocol, nextPhase.id)) {
    const planContent = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContent) {
      state.plan_phases = extractPlanPhases(planContent);
      // extractPlanPhases already marks first phase as in_progress
      if (state.plan_phases.length > 0) {
        state.current_plan_phase = state.plan_phases[0].id;
      }
    }
  }

  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${nextPhase.id} phase-transition`);

  console.log('');
  console.log(chalk.green(`ADVANCING TO: ${nextPhase.id} - ${nextPhase.name}`));

  // If we just entered implement phase, show phase 1 info and the critical warning
  if (isPhased(protocol, nextPhase.id) && state.plan_phases.length > 0) {
    const firstPhase = state.plan_phases[0];
    const nextPlanPhase = state.plan_phases[1];

    console.log('');
    console.log(chalk.bold(`YOUR TASK: ${firstPhase.id} - "${firstPhase.title}"`));

    // Show phase content from plan (via resolver if available)
    const planContentForDisplay = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContentForDisplay) {
      const phaseContent = getPhaseContent(planContentForDisplay, firstPhase.id);
      if (phaseContent) {
        console.log(section('FROM THE PLAN', phaseContent.slice(0, 800)));
      }
    }

    console.log('');
    console.log(phaseHandoffRules(state.id, firstPhase.id, nextPlanPhase?.id));
  }

  console.log(`\n  Run: porch status ${state.id}`);
}

/**
 * porch gate <id>
 * Requests human approval for current gate.
 */
export interface GateOptions {
  requestFile?: string;
}

export async function gate(
  workspaceRoot: string,
  projectId: string,
  resolver?: ArtifactResolver,
  options: GateOptions = {},
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(projectNotFoundMessage(workspaceRoot, projectId));
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);
  const gateName = getPhaseGate(protocol, state.phase);

  if (!gateName) {
    if (options.requestFile) {
      throw new Error(`Cannot attach a gate request: phase ${state.phase} has no approval gate`);
    }
    console.log(chalk.dim('No gate required for this phase.'));
    console.log(`\n  Run: porch done ${state.id}`);
    return;
  }

  const existingGate = state.gates[gateName];
  if (options.requestFile && existingGate?.status === 'approved') {
    throw new Error(`Cannot attach a gate request: ${gateName} is already approved`);
  }

  // Fully read and validate before touching state, so all failures are atomic.
  const request = options.requestFile
    ? readGateRequestFile(workspaceRoot, options.requestFile)
    : undefined;

  // Mark the current gate as requested. A flag-free call deliberately preserves
  // any existing request for backwards compatibility with old protocol steps.
  const gateStatus = existingGate ?? { status: 'pending' as const };
  state.gates[gateName] = gateStatus;
  const firstRequest = !gateStatus.requested_at;
  const requestChanged = request !== undefined && !isDeepStrictEqual(gateStatus.request, request);
  if (firstRequest) {
    gateStatus.requested_at = new Date().toISOString();
  }
  if (requestChanged) {
    gateStatus.request = request;
  }
  if (firstRequest || requestChanged) {
    const action = firstRequest ? 'gate-requested' : 'gate-request-updated';
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gateName} ${action}`);
  }

  console.log('');
  console.log(chalk.bold(`GATE: ${gateName}`));
  console.log('');

  // Show relevant artifact and open it for review
  const artifact = getArtifactForPhase(workspaceRoot, state, resolver);
  if (artifact) {
    const fullPath = path.join(workspaceRoot, artifact);
    if (fs.existsSync(fullPath)) {
      console.log(`  Artifact: ${artifact}`);
      const config = loadConfig(workspaceRoot);
      if (config.porch?.autoOpenArtifacts !== false) {
        console.log('');
        console.log(chalk.cyan('  Opening artifact for human review...'));
        // Use afx open to display in annotation viewer
        const { spawn } = await import('node:child_process');
        spawn('afx', ['open', fullPath], {
          stdio: 'inherit',
          detached: true
        }).unref();
      }
    }
  }

  console.log('');
  console.log(chalk.yellow('  Human approval required. STOP and wait.'));
  console.log('  Do not proceed until gate is approved.');
  console.log('');
  console.log(chalk.bold('STATUS: WAITING FOR HUMAN APPROVAL'));
  console.log('');
  console.log(chalk.dim(`  To approve: porch approve ${state.id} ${gateName}`));
  console.log('');
}

/**
 * Injection seams for `approve`. Production passes none of them; tests pass all
 * of them so an approval decision is never made from the ambient environment of
 * whatever process happens to be running the suite. A builder running vitest
 * carries CODEV_BUILDER_ID, so reading `process.env` implicitly in a test would
 * attribute every test approval to an agent session.
 */
export interface ApproveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly capabilities?: ApprovalCapabilityStore;
  readonly nonces?: ApprovalNonceStore;
  /**
   * What a refusal does. The CLI exits; a SERVER MUST NOT.
   *
   * Spec 146 Phase 11 calls this function in codev-agent's process to spend a
   * capability, and `process.exit(1)` there would take Tower down and answer the
   * request with nothing at all — the worst possible spelling of "refused".
   * Defaults to `'exit'`, so every existing caller behaves exactly as before.
   */
  readonly onRefusal?: 'exit' | 'throw';
  /**
   * Refuse BEFORE running the phase's checks, rather than running them.
   *
   * An HTTP request is the wrong place to run a repository's build and test
   * suite: it is unbounded, it holds a connection open for minutes, and a caller
   * that gives up does not stop porch — so a timeout would abandon a call that
   * goes on to approve the gate anyway, reporting one outcome while another
   * happened. Refusing up front is bounded by construction and says what is
   * needed instead of guessing at it.
   *
   * Set only by codev-agent. The CLI runs the checks, as it always has.
   */
  readonly refuseIfChecksWouldRun?: boolean;
}

/**
 * WHAT AN `approve()` CALL ACTUALLY DID.
 *
 * `approve` used to return `void`, and it returns NORMALLY when the gate was
 * already approved. A caller could not tell "I approved this" from "somebody
 * else already had", so codev-agent answered both with GATE_APPROVED, the
 * requesting session id, and a fresh timestamp — claiming that session approved
 * a gate it did not, at a time that never happened. Provenance falsified by a
 * missing return value.
 *
 * `record` is the record PERSISTED IN `status.yaml`, never one built for the
 * response, so a caller reporting an approval reports the one that exists.
 */
export interface ApproveOutcome {
  /**
   * `approved` — this invocation performed the gate transition.
   * `already-approved` — it was approved before this call and nothing changed.
   */
  readonly outcome: 'approved' | 'already-approved';
  /** From `status.yaml`. Absent only on records that predate the field. */
  readonly approvedAt?: string;
  readonly record?: ApprovalRecord;
  /**
   * How far the gate write got, when it did not get all the way.
   *
   * Absent means written, committed and pushed. The two failure stages are kept
   * apart because they are different instructions: one needs a push from the
   * worktree, the other needs the commit investigated — and NEITHER means the
   * gate is unapproved, which is the thing a caller must not get wrong.
   */
  readonly delivery?: 'written-not-committed' | 'committed-not-pushed';
  /** The failure in the words of whatever failed. */
  readonly deliveryMessage?: string;
}

/**
 * A refusal raised instead of exiting, for in-process callers.
 *
 * Carries the same `code` and `message` the CLI prints, so a route can answer
 * with the reason rather than a generic failure.
 */
export class ApprovalRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ApprovalRefusedError';
  }
}

/**
 * porch approve <id> <gate> --a-human-explicitly-approved-this
 *
 * Spec 146 Phase 6: the flag is a typed confirmation of intent, NOT a control.
 * It only ever asserted that a string appeared in argv, and a builder with a
 * shell can type that string. Authorization is the approval capability, resolved
 * by `resolveApprovalAuthorization` before anything on disk is touched.
 */
export async function approve(
  workspaceRoot: string,
  projectId: string,
  gateName: string,
  hasHumanFlag: boolean,
  resolver?: ArtifactResolver,
  options: ApproveOptions = {},
): Promise<ApproveOutcome> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(projectNotFoundMessage(workspaceRoot, projectId));
  }

  // Scope artifact reads + check cwd to the worktree that owns this status.yaml
  // (bugfix #676 — see check() for rationale).
  const artifactRoot = getArtifactRoot(statusPath);
  const scopedResolver = scopeResolver(workspaceRoot, artifactRoot, resolver);

  // AUTHORIZATION HAPPENS BEFORE ANY MUTATION.
  //
  // Both `writeStateAndCommit` calls below (the verify auto-completion and the
  // gate auto-creation for upgraded projects) used to run ABOVE the flag test,
  // so a refused call had already written and committed `status.yaml`. Nothing
  // between here and the first write may move above this block.
  //
  // The flag is checked first only because it is the cheaper, more actionable
  // message; failing it is not an authorization decision.
  /*
   * NOTHING IS PRINTED WHEN A PROGRAM IS CALLING.
   *
   * Every line below went to stdout, and `onRefusal: 'throw'` means codev-agent
   * is calling this in Tower's process — so an approval from the client wrote
   * ANSI-coloured porch output into Tower's log, where it is noise at best and,
   * on a refusal, a second and differently-worded account of an answer the
   * caller already has as a typed error. The CLI is unchanged.
   */
  const say = options.onRefusal === 'throw'
    ? (): void => {}
    : (...args: unknown[]): void => console.log(...args);

  /*
   * NOT REMOVABLE, DESPITE LOOKING LIKE IT. This exists so a caller can be given
   * a typed refusal instead of having the process exited from under it, and the
   * verbose annotation is load-bearing: TypeScript narrows after a call only
   * when the VARIABLE is declared to return `never`. Written as
   * `const refuse = (...): never =>` it still type-checks, and every line below
   * a refusal is then treated as reachable — which is how a refusal ends up
   * falling through into an approval.
   *
   * Simplify at your peril; `spec-146-phase-11-approval-writes.test.ts` covers
   * the behaviour, not this shape.
   */
  const refuse: (code: string, message: string) => never = (code, message) => {
    if (options.onRefusal === 'throw') throw new ApprovalRefusedError(code, message);
    process.exit(1);
  };

  if (!hasHumanFlag) {
    say('');
    say(chalk.red('ERROR: Human approval required.'));
    say('');
    say('  To approve, please run:');
    say('');
    say(chalk.cyan(`    porch approve ${projectId} ${gateName} --a-human-explicitly-approved-this`));
    say('');
    refuse('HUMAN_APPROVAL_REQUIRED', 'this call did not assert an explicit human approval');
  }

  const approvalDecision = resolveApprovalAuthorization({
    projectId,
    gateName,
    artifactRoot,
    cwd: options.cwd ?? workspaceRoot,
    env: options.env ?? process.env,
    capabilities: options.capabilities ?? new ApprovalCapabilityStore(),
    nonces: options.nonces ?? new ApprovalNonceStore(),
  });
  if (!approvalDecision.authorized) {
    say('');
    say(chalk.red(`ERROR: approval refused (${approvalDecision.code}).`));
    say(`  ${approvalDecision.message}`);
    say('');
    say('  Approve from the client, or from a shell holding a capability:');
    say(chalk.cyan(`    ${CAPABILITY_ENV_VAR}=<id>.<secret> ${NONCE_ENV_VAR}=<nonce> \\`));
    say(chalk.cyan(`      porch approve ${projectId} ${gateName} --a-human-explicitly-approved-this`));
    say('');
    refuse(approvalDecision.code, approvalDecision.message);
  }
  const approvalRecord = approvalDecision.record;
  if (approvalRecord.authorization === 'flag-only') {
    // Said out loud rather than left silent: this approval carries no evidence
    // of who made it. Silence here would read as "a human was verified".
    say(chalk.yellow('  Approving with no capability: this approval records no session id.'));
  }

  const state = readState(statusPath);

  /*
   * A WRITE THAT HAPPENS BEFORE THE GATE IS APPROVED.
   *
   * `writeStateAndCommit` throws `StatePushFailed` when the state was written
   * and committed but the push failed, and codev-agent turns that into
   * "approved, but not pushed — do not approve again". That is right for the
   * gate write and CATASTROPHIC for the three writes above it: a push failure
   * during the verify auto-complete, the upgrade gate-creation or the verify
   * phase transition would report an approval that never happened AND tell the
   * human not to retry. They walk away believing a gate is approved that is not.
   *
   * The round before this one had the opposite bug — a successful approval
   * reported as a refusal — which merely made someone re-approve. Same class,
   * opposite sign, and this direction is far worse.
   *
   * So a push failure before the gate write is translated into an ordinary
   * failure, which says plainly that the gate was NOT approved. Only the write
   * at the end may raise `StatePushFailed`, and
   * `spec-146-phase-11-approval-writes.test.ts` reads this function's source to
   * assert that stays true — the push is skipped under VITEST, so no behavioural
   * test can reach this.
   */
  const writeBeforeApproval = async (message: string): Promise<void> => {
    try {
      await writeStateAndCommit(statusPath, state, message);
    } catch (error: unknown) {
      // BOTH delivery failures, because both leave the gate unapproved when they
      // happen HERE. Only the gate write's failures are a caveat on a real
      // approval; these are failures of a preparatory step, and saying "approved
      // but not pushed" about one would be a completed approval that never was.
      if (error instanceof StatePushFailed || error instanceof StateCommitFailed) {
        throw new Error(
          `the ${gateName} gate was NOT approved: a preparatory write did not complete `
          + `(${message}). ${error.message}`,
        );
      }
      throw error;
    }
  };

  // Convenience: for verify-approval, auto-complete porch done if build_complete is false
  if (gateName === 'verify-approval' && state.phase === 'verify' && !state.build_complete) {
    state.build_complete = true;
    await writeBeforeApproval(`chore(porch): ${state.id} verify build-complete (auto)`);
  }

  // Auto-create gate entry for upgraded projects (e.g., verify-approval missing after upgrade)
  if (!state.gates[gateName]) {
    const protocol = loadProtocol(workspaceRoot, state.protocol);
    const phaseGate = getPhaseGate(protocol, state.phase);
    if (phaseGate === gateName) {
      // Gate belongs to the current phase — initialize it
      state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
      await writeBeforeApproval(`chore(porch): ${state.id} ${gateName} gate-created (upgrade)`);
    } else {
      const knownGates = Object.keys(state.gates).join(', ');
      throw new Error(`Unknown gate: ${gateName}\nKnown gates: ${knownGates || 'none'}`);
    }
  }

  if (state.gates[gateName].status === 'approved') {
    say(chalk.yellow(`Gate ${gateName} is already approved.`));
    // The EXISTING record, so a caller reports the approval that happened rather
    // than the one it just asked for.
    return {
      outcome: 'already-approved',
      ...(state.gates[gateName].approved_at ? { approvedAt: state.gates[gateName].approved_at } : {}),
      ...(state.gates[gateName].approval ? { record: state.gates[gateName].approval } : {}),
    };
  }

  // Run phase checks before approving
  const protocol = loadProtocol(workspaceRoot, state.protocol);

  // Issue #113: verify-approval is the post-merge gate. After a normal merge
  // the project is still in review (porch done after the pr gate is a separate
  // step). Approving this gate must not re-run review's pr_exists — that check
  // keys off git branch --show-current in whichever worktree findStatusPath
  // returns, which after merge is almost never the PR head. Enter verify first
  // so the checks below are the verify phase's (none) and the existing
  // auto-advance can reach verified.
  if (gateName === 'verify-approval' && state.phase !== 'verify') {
    if (state.phase === 'review' && state.gates['pr']?.status === 'approved') {
      state.phase = 'verify';
      state.build_complete = true;
      await writeBeforeApproval(`chore(porch): ${state.id} verify phase-transition (verify-approval)`);
    } else {
      throw new Error(
        `Cannot approve verify-approval from phase '${state.phase}'. ` +
        `The pr gate must be approved first.`,
      );
    }
  }

  const overrides = loadCheckOverrides(workspaceRoot, state.protocol);
  const phaseConfig = getPhaseConfig(protocol, state.phase);
  const phaseCheckNames = phaseConfig?.checks ?? [];
  const checks = getPhaseChecks(protocol, state.phase, overrides ?? undefined, workspaceRoot);

  if (phaseCheckNames.length > 0 && Object.keys(checks).length > 0 && options.refuseIfChecksWouldRun) {
    // Asked with porch's OWN computation of what would run — after overrides —
    // rather than a second reading of the protocol that could drift from it.
    refuse(
      'PHASE_CHECKS_REQUIRED',
      `approving ${gateName} would run the ${state.phase} phase checks `
      + `(${Object.keys(checks).join(', ')}), which this caller will not run. `
      + 'Run them where they belong, then approve.',
    );
  }

  if (phaseCheckNames.length > 0) {
    const checkEnv: CheckEnv = { PROJECT_ID: state.id, PROJECT_TITLE: resolveArtifactBaseName(artifactRoot, state.id, state.title, scopedResolver) };

    say('');
    say(chalk.bold('RUNNING CHECKS...'));
    logCheckOverrides(phaseCheckNames, checks, overrides);

    if (Object.keys(checks).length > 0) {
      const results = await runPhaseChecks(checks, artifactRoot, checkEnv, undefined, scopedResolver);
      say(formatCheckResults(results));

      if (!allChecksPassed(results)) {
        // The CLI exits here. A server MUST NOT: failing checks are a refusal
        // with a reason, not a reason to end the process and answer nothing.
        if (options.onRefusal === 'throw') {
          throw new ApprovalRefusedError(
            'PHASE_CHECKS_FAILED',
            `the ${state.phase} phase checks did not pass, so the gate was not approved`,
          );
        }
        exitChecksNotPassed(results, 'Cannot approve gate.');
      }
    } else {
      say(chalk.dim('  (all checks skipped via .codev/config.json)'));
    }
  }

  // Spend the single-use nonce HERE, not at authorization time. Everything above
  // this line — the already-approved early return and the phase checks — can end
  // the call without an approval, and burning the nonce on those would force a
  // re-mint through the authenticated route for no reason.
  const nonceCommit = approvalDecision.consumeNonce?.();
  if (nonceCommit && !nonceCommit.accepted) {
    say('');
    say(chalk.red(`ERROR: approval refused (${nonceCommit.code}).`));
    say(`  ${nonceCommit.message}`);
    say('');
    refuse(nonceCommit.code, nonceCommit.message);
  }

  state.gates[gateName].status = 'approved';
  state.gates[gateName].approved_at = approvalRecord.approved_at;
  state.gates[gateName].approval = approvalRecord;
  // Issue #872 / #887: human approving the pr gate means they've acted — the
  // PR is no longer waiting on a reviewer, so the pr-ready signal must go
  // false in the same write that records the approval. Clearing on
  // gate-approval covers all five PR-emitting protocols (SPIR / ASPIR / PIR /
  // AIR / BUGFIX), each of which now carries `gate: "pr"` on its PR-creating
  // phase — #887 closed the BUGFIX special case.
  if (gateName === 'pr') {
    state.pr_ready_for_human = false;
  }
  /*
   * THE ONE WRITE THAT MAY RAISE `StatePushFailed` TO THE CALLER.
   *
   * Everything above went through `writeBeforeApproval`, which converts a push
   * failure into an ordinary failure saying the gate was NOT approved. From
   * here the gate IS approved and committed, so a push failure is a caveat on a
   * real approval — and the caller is told which of the two it has.
   */
  let delivery: ApproveOutcome['delivery'];
  let deliveryMessage: string | undefined;
  try {
    await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} ${gateName} gate-approved`);
  } catch (error: unknown) {
    // `writeState` ran before either git step, so `status.yaml` says approved in
    // both cases and porch reads `status.yaml`. THE GATE IS APPROVED. What
    // failed is how far that fact travelled, and the caller is told which.
    if (error instanceof StateCommitFailed) {
      delivery = 'written-not-committed';
    } else if (error instanceof StatePushFailed) {
      delivery = 'committed-not-pushed';
    } else {
      throw error;
    }
    deliveryMessage = (error as Error).message;
    say('');
    say(chalk.yellow(`  ${deliveryMessage}`));
  }

  // Wake the builder iff porch was invoked from OUTSIDE the builder's
  // worktree. The wake-up wakes an *idle* builder; when the builder is
  // the one running `porch approve` (the user typed feedback into the
  // builder's pane and the builder ran the command itself), it's already
  // active and the message would be echoed back as the builder's next
  // input — Claude then "responds" to its own approval message.
  //
  // workspaceRoot is process.cwd() at CLI invocation. When called from
  // inside the worktree it resolves to the same path as artifactRoot.
  const calledFromBuilderWorktree = path.resolve(workspaceRoot) === path.resolve(artifactRoot);
  if (!calledFromBuilderWorktree) {
    // Issue #264: addressed by the PROJECT's worktree, never by its bare id.
    // `state.id` plus the invoking process's workspace was an address that could
    // resolve anywhere on the machine; `artifactRoot` is the directory whose
    // status.yaml was just written, so it names one builder in one workspace or
    // it names nothing.
    notifyGateApproved(artifactRoot, state.id, gateName);
  }

  say('');
  say(chalk.green(`Gate ${gateName} approved.`));

  // For verify-approval: auto-advance to terminal state (convenience — one command)
  // NOTE: The 'verified' state is committed to the builder branch, which may not
  // be merged back to main. The closed GitHub Issue serves as the canonical "done"
  // signal on main. State alignment (making status.yaml on main authoritative) is
  // tracked as future work per spec 653.
  if (gateName === 'verify-approval') {
    await advanceProtocolPhase(workspaceRoot, state, protocol, statusPath, resolver);
  } else {
    say(`\n  Run: porch done ${state.id} (to advance)`);
  }
  say('');

  // Read back off the state that was written, not off the decision that produced
  // it: a caller reporting this approval reports the one now in status.yaml.
  return {
    outcome: 'approved',
    ...(state.gates[gateName].approved_at ? { approvedAt: state.gates[gateName].approved_at } : {}),
    ...(state.gates[gateName].approval ? { record: state.gates[gateName].approval } : {}),
    ...(delivery ? { delivery, deliveryMessage } : {}),
  };
}

/**
 * porch rollback <id> <phase>
 * Rewinds project to an earlier phase, clearing downstream gates and resetting build state.
 */
export async function rollback(
  workspaceRoot: string,
  projectId: string,
  targetPhase: string,
  resolver?: ArtifactResolver
): Promise<void> {
  const statusPath = findStatusPath(workspaceRoot, projectId);
  if (!statusPath) {
    throw new Error(projectNotFoundMessage(workspaceRoot, projectId));
  }

  const state = readState(statusPath);
  const protocol = loadProtocol(workspaceRoot, state.protocol);

  // Validate target phase exists in protocol
  const targetConfig = getPhaseConfig(protocol, targetPhase);
  if (!targetConfig) {
    const validPhases = protocol.phases.map(p => p.id).join(', ');
    throw new Error(`Unknown phase: ${targetPhase}\nValid phases: ${validPhases}`);
  }

  // Find indices to validate rollback direction
  const currentIndex = protocol.phases.findIndex(p => p.id === state.phase);
  const targetIndex = protocol.phases.findIndex(p => p.id === targetPhase);

  // Handle completed projects (phase not in protocol phases array)
  if (state.phase === 'verified' || state.phase === 'complete') {
    // Allow rollback from complete state to any valid phase
  } else if (currentIndex === -1) {
    throw new Error(`Current phase '${state.phase}' not found in protocol.`);
  } else if (targetIndex >= currentIndex) {
    throw new Error(
      `Cannot rollback forward. Current phase: ${state.phase}, target: ${targetPhase}\n` +
      `Use 'porch done' to advance phases.`
    );
  }

  // Clear gates at or after the target phase
  for (let i = targetIndex; i < protocol.phases.length; i++) {
    const phase = protocol.phases[i];
    if (phase.gate && state.gates[phase.gate]) {
      state.gates[phase.gate] = { status: 'pending' };
    }
  }

  // Reset state to target phase
  const previousPhase = state.phase;
  state.phase = targetPhase;
  state.iteration = 1;
  state.build_complete = false;
  state.history = [];
  // Issue #872: rolling back past the PR-creating phase invalidates the
  // pr-ready signal — work is going backwards, so any previously-emitted
  // "ready for human" state no longer reflects reality.
  state.pr_ready_for_human = false;

  // If rolling back to a phased phase, re-extract plan phases
  if (isPhased(protocol, targetPhase)) {
    const planContent = resolver?.getPlanContent(state.id, state.title)
      ?? (() => { const p = findPlanFile(workspaceRoot, state.id, state.title); return p ? fs.readFileSync(p, 'utf-8') : null; })();
    if (planContent) {
      state.plan_phases = extractPlanPhases(planContent);
      if (state.plan_phases.length > 0) {
        state.current_plan_phase = state.plan_phases[0].id;
      } else {
        state.current_plan_phase = null;
      }
    } else {
      state.plan_phases = [];
      state.current_plan_phase = null;
    }
  } else {
    state.plan_phases = [];
    state.current_plan_phase = null;
  }

  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} rollback ${previousPhase} → ${targetPhase}`);

  console.log('');
  console.log(chalk.green(`ROLLED BACK: ${previousPhase} → ${targetPhase}`));
  console.log(`  Project: ${state.id}`);
  console.log(`  Protocol: ${state.protocol}`);
  console.log(`\n  Run: porch status ${state.id}`);
  console.log('');
}

/**
 * porch init <protocol> <id> <name>
 * Initialize a new project.
 *
 * Idempotent: if status.yaml already exists, preserves it and reports
 * current state. This supports `afx spawn --resume` where the builder
 * may re-run `porch init` after a session restart.
 */
export async function init(
  workspaceRoot: string,
  protocolName: string,
  projectId: string,
  projectName: string
): Promise<void> {
  const protocol = loadProtocol(workspaceRoot, protocolName);
  const statusPath = getStatusPath(workspaceRoot, projectId, projectName);

  // If status.yaml already exists, preserve it (idempotent for resume)
  if (fs.existsSync(statusPath)) {
    const existingState = readState(statusPath);
    console.log('');
    console.log(chalk.yellow(`Project ${projectId}-${projectName} already exists. Preserving existing state.`));
    console.log(`  Protocol: ${existingState.protocol}`);
    console.log(`  Current phase: ${existingState.phase}`);
    if (existingState.current_plan_phase) {
      console.log(`  Plan phase: ${existingState.current_plan_phase}`);
    }
    console.log(`\n  Run: porch next ${projectId}`);
    console.log('');
    return;
  }

  // Also check if a project with this ID exists under a different name
  const existingPath = findStatusPath(workspaceRoot, projectId, { alias: false });
  if (existingPath) {
    const existingState = readState(existingPath);
    console.log('');
    console.log(chalk.yellow(`Project ${projectId} already exists (as ${existingState.id}-${existingState.title}). Preserving existing state.`));
    console.log(`  Protocol: ${existingState.protocol}`);
    console.log(`  Current phase: ${existingState.phase}`);
    if (existingState.current_plan_phase) {
      console.log(`  Plan phase: ${existingState.current_plan_phase}`);
    }
    console.log(`\n  Run: porch next ${projectId}`);
    console.log('');
    return;
  }

  const state = createInitialState(protocol, projectId, projectName, workspaceRoot);
  await writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} init ${protocolName}`);

  console.log('');
  console.log(chalk.green(`Project initialized: ${projectId}-${projectName}`));
  console.log(`  Protocol: ${protocolName}`);
  console.log(`  Starting phase: ${state.phase}`);
  console.log(`\n  Run: porch status ${projectId}`);
  console.log('');
}

// ============================================================================
// Helpers
// ============================================================================

function getInstructions(state: ProjectState, protocol: Protocol): string {
  const phase = state.phase;

  if (isPhased(protocol, phase) && state.plan_phases.length > 0) {
    const current = getCurrentPlanPhase(state.plan_phases);
    if (current) {
      return `  You are implementing ${current.id}: "${current.title}".\n\n  Complete the work, then run: porch check ${state.id}`;
    }
  }

  const phaseConfig = getPhaseConfig(protocol, phase);
  return `  You are in the ${phaseConfig?.name || phase} phase.\n\n  When complete, run: porch done ${state.id}`;
}

function getNextAction(state: ProjectState, protocol: Protocol): string {
  const checks = getPhaseChecks(protocol, state.phase);
  const gate = getPhaseGate(protocol, state.phase);

  if (gate && state.gates[gate]?.status === 'pending' && state.gates[gate]?.requested_at) {
    return chalk.yellow('Wait for human to approve the gate.');
  }

  if (isPhased(protocol, state.phase)) {
    const current = getCurrentPlanPhase(state.plan_phases);
    if (current) {
      return `Implement ${current.title} as specified in the plan.`;
    }
  }

  if (Object.keys(checks).length > 0) {
    return `Complete the phase work, then run: porch check ${state.id}`;
  }

  return `Complete the phase work, then run: porch done ${state.id}`;
}

/**
 * porch pending
 * List all projects with gates awaiting human approval.
 * Scans both the local workspace and any builder worktrees under .builders/*.
 */
export async function pending(workspaceRoot: string): Promise<void> {
  type PendingGate = {
    id: string;
    title: string;
    phase: string;
    gate: string;
    requested_at?: string;
    statusPath: string;
  };

  const seen = new Set<string>(); // dedupe by status.yaml path
  const results: PendingGate[] = [];

  // Build the list of project directories to scan: main + every builder worktree.
  const projectsDirs: string[] = [path.join(workspaceRoot, 'codev', 'projects')];
  const buildersDir = path.join(workspaceRoot, '.builders');
  if (fs.existsSync(buildersDir)) {
    for (const wt of fs.readdirSync(buildersDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      projectsDirs.push(path.join(buildersDir, wt.name, 'codev', 'projects'));
    }
  }

  for (const projectsDir of projectsDirs) {
    if (!fs.existsSync(projectsDir)) continue;
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (!fs.existsSync(statusPath)) continue;

      const realPath = fs.realpathSync(statusPath);
      if (seen.has(realPath)) continue;
      seen.add(realPath);

      let state: ProjectState;
      try {
        state = readState(statusPath);
      } catch {
        continue; // skip corrupted status files
      }

      for (const [gateName, gateStatus] of Object.entries(state.gates)) {
        if (gateStatus?.status === 'pending' && gateStatus.requested_at) {
          results.push({
            id: state.id,
            title: state.title,
            phase: state.phase,
            gate: gateName,
            requested_at: gateStatus.requested_at,
            statusPath,
          });
        }
      }
    }
  }

  console.log('');
  if (results.length === 0) {
    console.log(chalk.dim('No gates pending approval.'));
    console.log('');
    return;
  }

  // Sort oldest-first so the longest-waiting gates surface at the top.
  results.sort((a, b) => (a.requested_at ?? '').localeCompare(b.requested_at ?? ''));

  console.log(chalk.bold(`${results.length} gate${results.length === 1 ? '' : 's'} pending approval:`));
  console.log('');
  for (const r of results) {
    console.log(`  ${chalk.cyan(r.id)} ${chalk.dim('—')} ${r.title}`);
    console.log(`    phase: ${r.phase}  gate: ${chalk.yellow(r.gate)}  requested: ${r.requested_at}`);
    console.log(chalk.dim(`    approve: porch approve ${r.id} ${r.gate} --a-human-explicitly-approved-this`));
    console.log('');
  }
}

function getArtifactForPhase(workspaceRoot: string, state: ProjectState, resolver?: ArtifactResolver): string | null {
  const baseName = resolveArtifactBaseName(workspaceRoot, state.id, state.title, resolver);
  switch (state.phase) {
    case 'specify':
      return `codev/specs/${baseName}.md`;
    case 'plan':
      return `codev/plans/${baseName}.md`;
    case 'review':
      return `codev/reviews/${baseName}.md`;
    default:
      return null;
  }
}

// ============================================================================
// CLI
// ============================================================================

function printUsage(): void {
  console.log('porch - Protocol Orchestrator');
  console.log('');
  console.log('Commands:');
  console.log('  next [id]                Emit next tasks as JSON (planner mode)');
  console.log('  status [id]              Show current state and instructions');
  console.log('  check [id]               Run checks for current phase');
  console.log('  done [id]                Signal build complete (validates checks, advances)');
  console.log('  done [id] --pr N --branch NAME   Record PR creation (no phase advancement)');
  console.log('  done [id] --merged N             Mark PR as merged (no phase advancement)');
  console.log('  gate [id] [--request-file PATH]  Request human approval');
  console.log('  pending                  List all gates awaiting approval across projects');
  console.log('  approve <id> <gate> --a-human-explicitly-approved-this');
  console.log(`                           (the flag confirms intent; the capability in`);
  console.log(`                            $${CAPABILITY_ENV_VAR} is what authorizes)`);
  console.log('  verify <id> --skip "reason"      Skip verification and mark as verified');
  console.log('  rollback <id> <phase>    Rewind project to an earlier phase');
  console.log('  init <protocol> <id> <name>  Initialize a new project');
  console.log('');
  console.log('Flags:');
  console.log('  --request-file PATH      Attach validated JSON content to the current gate');
  console.log('  --version, -v            Print porch (codev) version');
  console.log('  --help, -h               Print this usage and exit 0');
  console.log('');
  console.log('Project ID is auto-detected from worktree path or when exactly one project exists.');
  console.log('');
}

export function parseGateArgs(args: string[]): { projectIdArg?: string; requestFile?: string } {
  let projectIdArg: string | undefined;
  let requestFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--request-file') {
      if (requestFile !== undefined) throw new Error('--request-file may only be provided once');
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--request-file requires a path');
      requestFile = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown gate option: ${argument}`);
    } else if (projectIdArg === undefined) {
      projectIdArg = argument;
    } else {
      throw new Error(`Unexpected gate argument: ${argument}`);
    }
  }
  return { projectIdArg, requestFile };
}

export async function cli(args: string[]): Promise<void> {
  const [command, ...rest] = args;

  // Handle --version / -v before any project resolution — version output
  // must work from any directory and never require a project context.
  if (command === '--version' || command === '-v') {
    console.log(version);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const workspaceRoot = resolvePorchWorkspaceRoot();
  const resolver = getResolver(workspaceRoot);

  // Auto-detect project ID for commands that need it
  function getProjectId(provided?: string): string {
    const { id, source } = resolveProjectId(provided, process.cwd(), workspaceRoot);
    if (source === 'cwd') {
      console.log(chalk.dim(`[auto-detected project from worktree: ${id}]`));
    } else if (source === 'filesystem') {
      console.log(chalk.dim(`[auto-detected project: ${id}]`));
    }
    return id;
  }

  // Commands that mutate state. After dispatching, we fire a Tower
  // overview-refresh so subscribed clients (VSCode sidebar, dashboard)
  // pick up the change immediately instead of waiting for an unrelated
  // SSE event to incidentally cause a re-fetch.
  const MUTATING_COMMANDS = new Set(['next', 'done', 'gate', 'approve', 'rollback', 'verify', 'init']);

  try {
    switch (command) {
      case 'pending':
        await pending(workspaceRoot);
        break;

      case 'next': {
        const { next: porchNext } = await import('./next.js');
        const result = await porchNext(workspaceRoot, getProjectId(rest[0]));
        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'error') process.exit(1);
        break;
      }

      case 'run':
        console.error("Error: 'porch run' has been removed. Use 'porch next <id>' instead.");
        console.error("See: porch --help");
        process.exit(1);
        break;

      case 'status': {
        const json = rest.includes('--json');
        const positional = rest.find(a => !a.startsWith('--'));
        await status(workspaceRoot, getProjectId(positional), resolver, { json });
        break;
      }

      case 'check':
        await check(workspaceRoot, getProjectId(rest[0]), resolver);
        break;

      case 'done': {
        const doneOpts: { pr?: number; branch?: string; merged?: number } = {};
        const prIdx = rest.indexOf('--pr');
        const brIdx = rest.indexOf('--branch');
        const mergedIdx = rest.indexOf('--merged');
        if (prIdx !== -1) {
          const val = parseInt(rest[prIdx + 1], 10);
          if (!Number.isInteger(val) || val <= 0) throw new Error('--pr requires a positive integer PR number');
          doneOpts.pr = val;
        }
        if (brIdx !== -1) {
          if (!rest[brIdx + 1] || rest[brIdx + 1].startsWith('--')) throw new Error('--branch requires a branch name');
          doneOpts.branch = rest[brIdx + 1];
        }
        if (mergedIdx !== -1) {
          const val = parseInt(rest[mergedIdx + 1], 10);
          if (!Number.isInteger(val) || val <= 0) throw new Error('--merged requires a positive integer PR number');
          doneOpts.merged = val;
        }
        if (doneOpts.pr !== undefined && doneOpts.merged !== undefined) {
          throw new Error('--pr and --merged are mutually exclusive');
        }
        const hasRecordFlags = doneOpts.pr !== undefined || doneOpts.merged !== undefined;
        // For project ID: use first positional arg, or fall back to auto-detection
        const projectIdArg = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
        await done(workspaceRoot, getProjectId(projectIdArg), resolver, hasRecordFlags ? doneOpts : undefined);
        break;
      }

      case 'gate': {
        const { projectIdArg, requestFile } = parseGateArgs(rest);
        await gate(workspaceRoot, getProjectId(projectIdArg), resolver, { requestFile });
        break;
      }

      case 'approve':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch approve <id> <gate> --a-human-explicitly-approved-this');
        const hasHumanFlag = rest.includes('--a-human-explicitly-approved-this');
        await approve(workspaceRoot, rest[0], rest[1], hasHumanFlag, resolver);
        break;

      case 'rollback':
        if (!rest[0] || !rest[1]) throw new Error('Usage: porch rollback <id> <phase>');
        await rollback(workspaceRoot, rest[0], rest[1], resolver);
        break;

      case 'verify': {
        const verifyProjectId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
        const skipIdx = rest.indexOf('--skip');
        if (skipIdx === -1) throw new Error('Usage: porch verify <id> --skip "reason"');
        const skipReason = rest[skipIdx + 1];
        if (!skipReason || skipReason.startsWith('--')) throw new Error('--skip requires a reason');
        const pid = getProjectId(verifyProjectId);
        const sp = findStatusPath(workspaceRoot, pid);
        if (!sp) throw new Error(projectNotFoundMessage(workspaceRoot, pid));
        const st = readState(sp);
        if (st.phase !== 'verify') {
          throw new Error(`porch verify --skip can only be used in the verify phase (current: ${st.phase}). The PR must be merged first.`);
        }
        st.phase = 'verified';
        st.context = { ...st.context, verify_skip_reason: skipReason };
        await writeStateAndCommit(sp, st, `chore(porch): ${st.id} verify skipped: ${skipReason}`);
        notifyProtocolComplete(getArtifactRoot(sp), st.id);
        console.log('');
        console.log(chalk.green(`VERIFIED (skipped): ${st.id}`));
        console.log(`  Reason: ${skipReason}`);
        break;
      }

      case 'init':
        if (!rest[0] || !rest[1] || !rest[2]) {
          throw new Error('Usage: porch init <protocol> <id> <name>');
        }
        await init(workspaceRoot, rest[0], rest[1], rest[2]);
        break;

      default:
        printUsage();
        process.exit(command ? 1 : 0);
    }

    // After a successful mutating command, broadcast `overview-changed`
    // via Tower so VSCode / dashboard refresh without a manual reload.
    // Best-effort — silently no-ops if Tower isn't running.
    if (command && MUTATING_COMMANDS.has(command)) {
      try {
        const { TowerClient } = await import('../../agent-farm/lib/tower-client.js');
        await new TowerClient().refreshOverview();
      } catch {
        // Tower not running / unreachable — non-fatal.
      }
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

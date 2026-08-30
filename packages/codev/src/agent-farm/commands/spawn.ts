/**
 * Spawn command — orchestrator module.
 * Spec 0126: Project Management Rework — Phase 2 (Spawn CLI Rework)
 *
 * Modes (protocol-driven for issue-based spawns):
 * - spec:     afx spawn 315 --protocol spir     (feature)
 * - bugfix:   afx spawn 315 --protocol bugfix   (bug fix)
 * - task:     afx spawn --task "..."             (ad-hoc task)
 * - protocol: afx spawn --protocol maintain      (protocol-only run)
 * - shell:    afx spawn --shell                  (bare session)
 * - worktree: afx spawn --worktree              (worktree, no prompt)
 *
 * Role/prompt logic extracted to spawn-roles.ts.
 * Worktree/git logic extracted to spawn-worktree.ts.
 */

import { resolve, basename } from 'node:path';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import type { SpawnOptions, BuilderType, Config } from '../types.js';
import {
  getConfig,
  ensureDirectories,
  assertBuilderHarnessNotRetired,
  resolveBuilderSelection,
  assertHarnessCommandAgrees,
  type AgentSelection,
} from '../utils/index.js';
import { hasGateProfile } from '../servers/gate-profiles.js';
import type { HarnessProvider } from '../utils/harness.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { hasUncommittedTrackedChanges } from '../utils/git.js';
import { upsertBuilder, getBuilder } from '../state.js';
import {
  allocateSpawnThread,
  chooseSpawnPath,
} from '../db/thread-identity.js';
import { ensureThreadBackendReady } from '../thread-backend.js';

import { findStatusPath, getStatusPath, recordThreadId } from '../../commands/porch/state.js';
import { DEFAULT_ARCHITECT_NAME } from '../utils/architect-name.js';

/**
 * Spec 755: the spawning architect's name comes from the env var that Tower
 * injects into every architect terminal it starts (`CODEV_ARCHITECT_NAME`).
 * Falls back to 'main' when `afx spawn` runs outside any architect terminal —
 * the legacy single-architect case stays correct.
 *
 * Read once at module load. `afx spawn` is one-shot per CLI invocation, and
 * the env var doesn't change mid-run.
 */
const SPAWNING_ARCHITECT_NAME =
  (process.env.CODEV_ARCHITECT_NAME && process.env.CODEV_ARCHITECT_NAME.trim()) || DEFAULT_ARCHITECT_NAME;
import { loadRolePrompt } from '../utils/roles.js';
import { buildAgentName, stripLeadingZeros } from '../utils/agent-names.js';
import { fetchIssue as fetchIssueNonFatal } from '../../lib/github.js';
import {
  type TemplateContext,
  buildPromptFromTemplate,
  buildResumeNotice,
  loadProtocolRole,
  findSpecFile,
  findSpecLookup,
  validateProtocol,
  loadProtocol,
  resolveMode,
} from './spawn-roles.js';
import { getResolver } from '../../commands/porch/artifacts.js';
import {
  checkDependencies,
  createWorktree,
  createWorktreeFromBranch,
  initPorchInWorktree,
  checkBugfixCollisions,
  fetchGitHubIssue,
  executePreSpawnHooks,
  slugify,
  findExistingIssueWorktree,
  validateResumeWorktree,
  createPtySession,
  startBuilderSession,
  startShellSession,
  buildWorktreeLaunchScript,
  BUILDER_ROLE_FILE,
} from './spawn-worktree.js';
import { getTowerClient } from '../lib/tower-client.js';
import { executeForgeCommand, loadForgeConfig } from '../../lib/forge.js';

// =============================================================================
// ID and Session Management
// =============================================================================

/**
 * On --resume, ask the builder's harness for a resumable prior session for the
 * worktree so the revived builder can pick up the saved conversation (e.g.
 * `claude --resume <uuid>`) instead of starting fresh with a resume-notice
 * prompt. (Issues #831 / #929.) Returns undefined when not resuming, when the
 * harness has no resumable session, or when the harness doesn't support resume
 * (codex/gemini → buildResume undefined); callers fall back to the fresh-spawn
 * path in that case. Returning the harness's bundled resume object (with the
 * shell-escaped `scriptFragment`) keeps the resume flag-shape owned by the
 * provider rather than the bash-script generator.
 */
export function discoverResumeSession(
  worktreePath: string,
  isResume: boolean | undefined,
  harness: HarnessProvider,
): { sessionId: string; args: string[]; scriptFragment: string } | undefined {
  if (!isResume) return undefined;
  if (!harness.buildResume) {
    logger.info('This harness does not support conversation resume; starting a fresh session.');
    return undefined;
  }
  const resume = harness.buildResume(worktreePath);
  if (resume) {
    logger.kv('Session', `${resume.sessionId.slice(0, 8)}… (resuming conversation)`);
    return resume;
  }
  logger.info('No prior conversation found for this worktree; starting a fresh session.');
  return undefined;
}

function logSpawnSuccess(
  label: string,
  identity: { terminalId?: string; threadId?: string },
  mode?: string,
): void {
  const client = getTowerClient();
  logger.blank();
  logger.success(`${label} spawned!`);
  if (mode) logger.kv('Mode', mode === 'strict' ? 'Strict (porch-driven)' : 'Soft (protocol-guided)');
  if (identity.threadId) logger.kv('Thread', identity.threadId);
  if (identity.terminalId) logger.kv('Terminal', client.getTerminalWsUrl(identity.terminalId));
}

export async function launchSpawnedBuilder(opts: {
  existing?: { terminalId?: string; threadId?: string } | null;
  builderId: string;
  worktreePath: string;
  branch: string;
  harnessName?: string;
  model?: string;
  prompt?: string;
  launchScript?: string;
  roleContent?: string | null;
  roleFilePath?: string | null;
  startPty: () => Promise<{ terminalId: string }>;
  workspaceRoot?: string;
}): Promise<{ terminalId?: string; threadId?: string }> {
  // Issue #179 item 2: the production caller for installThreadSpawnFactory. Without
  // it no factory is ever registered and chooseSpawnPath returns `pty` unconditionally,
  // which made Phase 8's thread branch unreachable outside tests. A workspace with no
  // t3code server configured is unchanged — this is opt-in, not a flag day — but a
  // workspace that HAS one now actually takes the thread path.
  //
  // Skipped when the caller passes no workspaceRoot, which is how the unit tests drive
  // this function with an injected factory and no server.
  //
  // `prompt` and `roleContent` are the builder's actual mission, and reaching the thread
  // path is not the same as spawning a builder on it. Every call site used to pass the
  // generated prompt only into the `startPty` closure, so on the thread path the engine
  // received `prompt: undefined`, never began a turn, and produced a thread that exists
  // and has been told nothing — a spawn that looks successful and did not spawn anything.
  if (opts.workspaceRoot) await ensureThreadBackendReady(opts.workspaceRoot);
  // Named, so the keyed factory map is asked about THIS workspace. Unnamed it asks about
  // the unkeyed slot, which is how the unit tests drive an injected factory with no server
  // — and which never sees a real workspace's factory, deliberately (issue #227 item 1).
  const pathKind = chooseSpawnPath(opts.existing ?? undefined, opts.workspaceRoot);
  if (pathKind === 'thread') {
    const threadId = opts.existing?.threadId ?? await allocateSpawnThread({
      builderId: opts.builderId,
      worktreePath: opts.worktreePath,
      branch: opts.branch,
      harnessName: opts.harnessName,
      model: opts.model,
      prompt: opts.prompt,
      launchScript: opts.launchScript,
      roleContent: opts.roleContent,
      roleFilePath: opts.roleFilePath,
    }, opts.workspaceRoot);
    return { threadId };
  }
  return opts.startPty();
}

export function persistSpawnedBuilder(
  builder: Parameters<typeof upsertBuilder>[0],
  porch?: { worktreePath: string; projectId: string; projectName: string },
): void {
  if (builder.threadId && porch) {
    const statusPath = findStatusPath(porch.worktreePath, porch.projectId, { alias: false })
      ?? getStatusPath(porch.worktreePath, porch.projectId, porch.projectName);
    try {
      recordThreadId(statusPath, builder.threadId);
    } catch (err) {
      throw new Error(
        `Thread-backed spawn of ${builder.id} could not record thread_id=${builder.threadId} in status.yaml (${statusPath}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  upsertBuilder(builder);
}

/**
 * Generate a short 4-character base64-encoded ID
 * Uses URL-safe base64 (a-z, A-Z, 0-9, -, _) for filesystem-safe IDs
 */
function generateShortId(): string {
  // Generate random 24-bit number and base64 encode to 4 chars
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}

/**
 * Validate spawn options for the new positional-arg interface.
 *
 * Rules:
 * - issueNumber, task, shell, worktree are mutually exclusive
 * - --protocol is required when issueNumber is present (unless --resume or --soft)
 * - --protocol alone (no issueNumber) is valid as a protocol-only run
 * - TICK protocol removed (spec 653)
 */
function validateSpawnOptions(options: SpawnOptions): void {
  // Count primary input modes
  const inputModes = [
    options.issueNumber,
    options.task,
    options.shell,
    options.worktree,
  ].filter(Boolean);

  // --protocol alone (no other input) is a valid mode
  const protocolAlone = options.protocol && inputModes.length === 0;

  if (inputModes.length === 0 && !protocolAlone) {
    fatal(
      'Must specify an issue number or one of: --task, --protocol, --shell, --worktree\n\n' +
      'Usage:\n' +
      '  afx spawn 315 --protocol spir      # Feature with SPIR protocol\n' +
      '  afx spawn 315 --protocol bugfix    # Bug fix\n' +
      '  afx spawn --task "fix the bug"     # Ad-hoc task\n' +
      '  afx spawn --protocol maintain      # Protocol-only run\n' +
      '  afx spawn --shell                  # Bare session\n\n' +
      'Run "afx spawn --help" for more options.'
    );
  }

  if (inputModes.length > 1) {
    fatal('Issue number, --task, --shell, and --worktree are mutually exclusive');
  }

  // --protocol is required for issue-based spawns (unless --resume or --soft)
  if (options.issueNumber && !options.protocol && !options.resume && !options.soft) {
    fatal(
      '--protocol is required when spawning with an issue number.\n\n' +
      'Usage:\n' +
      '  afx spawn 315 --protocol spir      # Feature\n' +
      '  afx spawn 315 --protocol bugfix    # Bug fix\n' +
      '  afx spawn 315 --resume             # Resume (reads protocol from worktree)\n' +
      '  afx spawn 315 --soft               # Soft mode (defaults to SPIR)'
    );
  }

  if (options.files && !options.task) {
    fatal('--files requires --task');
  }

  if (options.noComment && !options.issueNumber) {
    fatal('--no-comment requires an issue number');
  }

  if (options.force && !options.issueNumber && !options.task && !options.protocol) {
    fatal('--force requires an issue number, --task, or --protocol');
  }

  // --protocol cannot be used with --shell or --worktree
  if (options.protocol && (options.shell || options.worktree)) {
    fatal('--protocol cannot be used with --shell or --worktree');
  }

  // --amends is no longer supported (TICK protocol removed, spec 653)
  if (options.amends) {
    fatal('--amends is no longer supported. The TICK protocol has been removed.');
  }

  // --strict and --soft are mutually exclusive
  if (options.strict && options.soft) {
    fatal('--strict and --soft are mutually exclusive');
  }

  // --branch mutual exclusions (Spec 609)
  if (options.branch) {
    if (options.resume) {
      fatal('--branch and --resume are mutually exclusive');
    }
    if (options.shell || options.worktree || options.task) {
      fatal('--branch requires an issue number and protocol (cannot be used with --shell, --worktree, or --task)');
    }
    if (!options.issueNumber) {
      fatal('--branch requires an issue number');
    }
    if (!options.protocol) {
      fatal('--branch requires --protocol (protocol cannot be auto-detected for existing branches)');
    }
  }

  // --remote requires --branch
  if (options.remote && !options.branch) {
    fatal('--remote requires --branch (specifies which remote to fetch the branch from)');
  }
}

/**
 * Determine the spawn mode from options.
 * Protocol drives the mode for issue-based spawns.
 */
function getSpawnMode(options: SpawnOptions): BuilderType {
  if (options.task) return 'task';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';

  if (options.issueNumber) {
    // Protocol drives the mode for issue-based spawns. Each issue-driven
    // protocol has its own mode value and its own dispatch entry — they share
    // an implementation through `spawnIssueDrivenBuilder`, not through the
    // dispatcher.
    if (options.protocol === 'bugfix') return 'bugfix';
    if (options.protocol === 'pir') return 'pir';
    return 'spec';
  }

  // --protocol alone (no issue number) is protocol mode
  if (options.protocol) return 'protocol';
  throw new Error('No mode specified');
}

/**
 * Resolve the protocol for issue-based spawns.
 * For --soft without --protocol, defaults to SPIR when a spec file exists.
 * For --resume without --protocol, infers from existing worktree directory.
 */
async function resolveIssueProtocol(
  options: SpawnOptions,
  config: Config,
): Promise<string> {
  // Explicit --protocol always wins
  if (options.protocol) {
    validateProtocol(config, options.protocol);
    return options.protocol.toLowerCase();
  }

  // --soft without --protocol: SPIR if spec file exists, bugfix otherwise
  if (options.soft && options.issueNumber) {
    const specFile = await findSpecFile(config.codevDir, String(options.issueNumber));
    return specFile ? 'spir' : 'bugfix';
  }

  // --resume without --protocol: infer from existing worktree
  if (options.resume && options.issueNumber) {
    const inferred = inferProtocolFromWorktree(config, options.issueNumber);
    if (inferred) return inferred;
    fatal(
      `Cannot infer protocol for issue #${options.issueNumber}.\n` +
      'No matching worktree found in .builders/. Specify --protocol explicitly.'
    );
  }

  fatal('--protocol is required');
  throw new Error('unreachable');
}

/**
 * Infer protocol from an existing worktree directory name.
 * Worktree naming: <protocol>-<id>-<slug> or bugfix-<id>-<slug>
 * Handles legacy zero-padded IDs: worktree `spir-0076-feature` matches issueNumber=76.
 */
function inferProtocolFromWorktree(config: Config, issueNumber: number | string): string | null {
  if (!existsSync(config.buildersDir)) return null;
  const strippedId = stripLeadingZeros(String(issueNumber));
  const dirs = readdirSync(config.buildersDir);
  // Match patterns like: spir-315-feature-name, bugfix-315-slug, spir-0076-feature
  const match = dirs.find(d => {
    const parts = d.split('-');
    return parts.length >= 2 && stripLeadingZeros(parts[1]) === strippedId;
  });
  if (match) {
    return match.split('-')[0];
  }
  return null;
}

// =============================================================================
// Mode-specific spawn implementations
// =============================================================================

/**
 * Spawn builder for a spec (SPIR, ASPIR, AIR, and other non-bugfix protocols)
 */
async function spawnSpec(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  const issueNumber = options.issueNumber!;
  const projectId = String(issueNumber);
  const strippedId = stripLeadingZeros(projectId);
  const protocol = await resolveIssueProtocol(options, config);
  const forgeConfig = loadForgeConfig(config.workspaceRoot);

  // Load protocol definition early — needed for input.required check
  const protocolDef = loadProtocol(config, protocol);

  const specLookupId = projectId;

  // Resolve the spec by EXACT id. The zero-stripped fallback was removed in #65:
  // it handed `afx spawn 63` the unrelated `0063-tower-dashboard-improvements.md`
  // and cost a builder-hour of well-argued work on the wrong subject.
  const specLookup = await findSpecLookup(config.codevDir, specLookupId);
  const specFile = specLookup.path;

  // Say why a spec file that plainly exists is not being used. Without this,
  // "no spec" looks like the lookup failed to see it.
  if (!specFile && specLookup.nearMiss) {
    logger.warn(
      `Not using ${basename(specLookup.nearMiss)} — its id only matches ${specLookupId} ` +
      `after stripping leading zeros, so it belongs to different work (#65). ` +
      `This issue has no spec yet. To spawn the legacy project itself, name it ` +
      `exactly: afx spawn ${basename(specLookup.nearMiss).split('-')[0]}`,
    );
  }

  // Try artifact resolver as fallback when no local spec file exists.
  // CLI backend users may store specs externally.
  let resolverSpecName: string | null = null;
  if (!specFile) {
    try {
      const resolver = getResolver(config.workspaceRoot);
      resolverSpecName = resolver.findSpecBaseName(specLookupId, '');
    } catch {
      // Resolver unavailable — fall through to normal error handling
    }

    // ...but don't let it hand back the twin we just declined (#65).
    //
    // The default backend is LocalResolver, which reads THE SAME codev/specs/
    // through findByProjectId — and that still keeps the lenient zero-stripped
    // fallback on purpose, because #28 chose to disclose an ambiguous artifact
    // rather than refuse it. Disclosure is right at review time, where a
    // reviewer can object. At spawn nobody is watching, so refusing here and
    // re-fetching four lines later would put the original bug back in the same
    // command run that just printed "Not using 0063-...".
    //
    // Verified live: LocalResolver.findSpecBaseName('63', '') returns
    // '0063-tower-dashboard-improvements' in this repo.
    //
    // Two paths this closes. When the forge fetch returns null (offline, gh
    // unauthenticated, forge misconfigured) `specName` falls through to the
    // resolver value and the builder is handed the wrong spec again. And a
    // truthy resolverSpecName suppresses the "Spec not found" fatal below,
    // satisfying a required-input protocol with a file the code refused.
    if (
      resolverSpecName &&
      specLookup.nearMiss &&
      resolverSpecName === basename(specLookup.nearMiss, '.md')
    ) {
      resolverSpecName = null;
    }
  }

  // When no spec file exists (and resolver didn't find one), check if the protocol allows spawning without one.
  if (!specFile && !resolverSpecName) {
    if (protocolDef?.input?.required === false) {
      // Protocol allows no-spec spawn — will derive naming from GitHub issue title
      logger.info('No spec file found. Protocol allows spawning without one (Specify phase will create it).');
    } else {
      fatal(`Spec not found for issue #${issueNumber}. Expected spec ID: ${specLookupId}`);
    }
  }

  // Fetch forge issue context.
  // When no spec file exists, this is fatal (we need a project name).
  // When spec file exists, this is non-fatal (spec filename is the fallback).
  let forgeIssue: Awaited<ReturnType<typeof fetchIssueNonFatal>> = null;
  if (!specFile && !resolverSpecName) {
    // Fatal fetch — we need the issue title for naming
    forgeIssue = await fetchGitHubIssue(issueNumber, { cwd: config.workspaceRoot, forgeConfig });
  } else {
    forgeIssue = await fetchIssueNonFatal(issueNumber, { forgeConfig });
  }

  // Derive specName for naming.
  // Priority: GitHub issue title > resolver spec name > spec filename
  let specName: string;
  if (forgeIssue) {
    specName = `${strippedId}-${slugify(forgeIssue.title)}`;
  } else if (resolverSpecName) {
    specName = resolverSpecName;
  } else {
    // No GitHub issue — fall back to spec filename (specFile must exist here)
    specName = basename(specFile!, '.md');
  }

  const builderId = buildAgentName('spec', projectId, protocol);

  // Spec 653: worktree path uses project ID only — no title suffix.
  // This decouples the worktree from the issue title so renames don't break --resume.
  let worktreeName: string;
  let branchName: string;
  if (options.branch) {
    branchName = options.branch;
    worktreeName = `${protocol}-${strippedId}`;
  } else if (options.resume) {
    // Migration: try ID-only path first, fall back to old title-based path
    const idOnlyName = `${protocol}-${strippedId}`;
    const idOnlyPath = resolve(config.buildersDir, idOnlyName);
    if (existsSync(idOnlyPath)) {
      worktreeName = idOnlyName;
    } else {
      // Search for old-format worktree: <protocol>-<id>-<title-slug>
      const prefix = `${protocol}-${strippedId}-`;
      try {
        const entries = readdirSync(config.buildersDir, { withFileTypes: true });
        const match = entries.find(e => e.isDirectory() && e.name.startsWith(prefix));
        worktreeName = match ? match.name : idOnlyName;
      } catch {
        worktreeName = idOnlyName;
      }
    }
    branchName = `builder/${worktreeName}`;
  } else {
    worktreeName = `${protocol}-${strippedId}`;
    branchName = `builder/${worktreeName}`;
  }
  const worktreePath = resolve(config.buildersDir, worktreeName);

  // For file references (template context, plan lookup), use the actual spec filename
  // when it exists. specName drives naming (worktree/branch/porch) but actual files
  // on disk may have a different name (e.g., "444-spawn-improvements" vs "444-af-spawn-should-not").
  const actualSpecName = specFile ? basename(specFile, '.md') : specName;

  // Check for corresponding plan file
  const planFile = resolve(config.codevDir, 'plans', `${actualSpecName}.md`);
  const hasPlan = existsSync(planFile);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (${protocol})`);
  logger.kv('Issue', `#${issueNumber}`);
  logger.kv('Spec', specFile ?? '(will be created by Specify phase)');
  if (options.branch) logger.kv('Existing Branch', branchName);
  else logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else if (options.branch) {
    await createWorktreeFromBranch(config, branchName, worktreePath, { remote: options.remote });
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const mode = resolveMode(options, protocolDef);

  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Pre-initialize porch so the builder doesn't need to figure out project ID
  if (!options.resume) {
    const porchProjectName = specName.replace(/^[0-9]+-/, '');
    await initPorchInWorktree(worktreePath, protocol, projectId, porchProjectName);
  }

  if (forgeIssue) {
    logger.kv('Issue', `#${issueNumber}: ${forgeIssue.title}`);
  }

  const specRelPath = `codev/specs/${actualSpecName}.md`;
  const planRelPath = `codev/plans/${actualSpecName}.md`;
  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    project_id: projectId,
    input_description: `the feature specified in ${specRelPath}`,
    spec: { path: specRelPath, name: actualSpecName },
    spec_missing: !specFile,
  };
  if (hasPlan) templateContext.plan = { path: planRelPath, name: actualSpecName };
  if (forgeIssue) {
    templateContext.issue = {
      number: issueNumber,
      title: forgeIssue.title,
      body: forgeIssue.body || '(No description provided)',
    };
  }
  if (options.branch) {
    templateContext.existing_branch = options.branch;
  }

  const effective = selectionForResume(options, config, builderId, selection);
  // Issue #2: discovery must use the SELECTION's harness. Reading the config
  // harness here would look for a claude session under a codex builder.
  const resume = discoverResumeSession(worktreePath, options.resume, effective.provider);

  const initialPrompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(projectId)}\n` : '';
  const branchNotice = options.branch
    ? `\n## Existing Branch\nYou are continuing work on existing branch \`${options.branch}\`. This branch may have commits from another contributor. Review the existing commits before making changes.\n`
    : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}${branchNotice}\n${initialPrompt}`;

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');

  const identity = await launchSpawnedBuilder({
    existing: options.resume ? getBuilder(builderId, config.workspaceRoot) : null,
    builderId, worktreePath, branch: branchName,
    workspaceRoot: config.workspaceRoot,
    harnessName: effective.harnessName, model: effective.modelId,
    prompt: builderPrompt,
    roleContent: role?.content ?? null,
    roleFilePath: role ? resolve(worktreePath, BUILDER_ROLE_FILE) : null,
    startPty: () => startBuilderSession(
      config, builderId, worktreePath, effective.command,
      builderPrompt, role?.content ?? null, role?.source ?? null,
      resume, effective,
    ),
  });

  persistSpawnedBuilder({
    id: builderId, name: specName, status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'spec', issueNumber,
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    harness: effective.harnessName,
    model: effective.modelId,
    ...identity,
  }, { worktreePath, projectId, projectName: specName.replace(/^[0-9]+-/, '') });

  logSpawnSuccess(`Builder ${builderId}`, identity, mode);
}

/**
 * Spawn builder for an ad-hoc task
 */
async function spawnTask(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  const taskText = options.task!;
  const shortId = generateShortId();
  const builderId = buildAgentName('task', shortId);
  const worktreeName = `task-${shortId}`;
  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (task)`);
  logger.kv('Task', taskText.substring(0, 60) + (taskText.length > 60 ? '...' : ''));
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  if (options.files && options.files.length > 0) {
    logger.kv('Files', options.files.join(', '));
  }

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  let taskDescription = taskText;
  if (options.files && options.files.length > 0) {
    taskDescription += `\n\nRelevant files to consider:\n${options.files.map(f => `- ${f}`).join('\n')}`;
  }

  const hasExplicitProtocol = !!options.protocol;
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  let builderPrompt: string;

  if (hasExplicitProtocol) {
    validateProtocol(config, options.protocol!);
    const protocol = options.protocol!.toLowerCase();
    const protocolDef = loadProtocol(config, protocol);
    const mode = resolveMode(options, protocolDef);
    const templateContext: TemplateContext = {
      protocol_name: protocol.toUpperCase(), mode,
      mode_soft: mode === 'soft', mode_strict: mode === 'strict',
      project_id: builderId, input_description: 'an ad-hoc task', task_text: taskDescription,
    };
    const prompt = buildPromptFromTemplate(config, protocol, templateContext);
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n${prompt}`;
    if (!options.resume) {
      await initPorchInWorktree(worktreePath, protocol, builderId, worktreeName);
    }
  } else {
    builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}\n# Task\n\n${taskDescription}`;
  }

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');
  const effective = selectionForResume(options, config, builderId, selection);

  const identity = await launchSpawnedBuilder({
    existing: options.resume ? getBuilder(builderId, config.workspaceRoot) : null,
    builderId, worktreePath, branch: branchName,
    workspaceRoot: config.workspaceRoot,
    harnessName: effective.harnessName, model: effective.modelId,
    prompt: builderPrompt,
    roleContent: role?.content ?? null,
    roleFilePath: role ? resolve(worktreePath, BUILDER_ROLE_FILE) : null,
    startPty: () => startBuilderSession(
      config, builderId, worktreePath, effective.command,
      builderPrompt, role?.content ?? null, role?.source ?? null,
      undefined, effective,
    ),
  });

  persistSpawnedBuilder({
    id: builderId,
    name: `Task: ${taskText.substring(0, 30)}${taskText.length > 30 ? '...' : ''}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'task', taskText,
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    harness: effective.harnessName,
    model: effective.modelId,
    ...identity,
  }, hasExplicitProtocol ? { worktreePath, projectId: builderId, projectName: worktreeName } : undefined);

  logSpawnSuccess(`Builder ${builderId}`, identity);
}

/**
 * Spawn builder to run a protocol (no issue number)
 */
async function spawnProtocol(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  const protocolName = options.protocol!;
  validateProtocol(config, protocolName);

  const shortId = generateShortId();
  const builderId = buildAgentName('protocol', shortId, protocolName);
  const worktreeName = `${protocolName}-${shortId}`;
  const branchName = `builder/${worktreeName}`;
  const worktreePath = resolve(config.buildersDir, worktreeName);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Builder ${builderId} (protocol)`);
  logger.kv('Protocol', protocolName);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const protocolDef = loadProtocol(config, protocolName);
  const mode = resolveMode(options, protocolDef);
  logger.kv('Mode', mode.toUpperCase());

  const templateContext: TemplateContext = {
    protocol_name: protocolName.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    project_id: builderId,
    input_description: `running the ${protocolName.toUpperCase()} protocol`,
  };
  const promptContent = buildPromptFromTemplate(config, protocolName, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const prompt = resumeNotice ? `${resumeNotice}\n${promptContent}` : promptContent;

  const role = options.noRole ? null : loadProtocolRole(config, protocolName);
  const effective = selectionForResume(options, config, builderId, selection);

  const identity = await launchSpawnedBuilder({
    existing: options.resume ? getBuilder(builderId, config.workspaceRoot) : null,
    builderId, worktreePath, branch: branchName,
    workspaceRoot: config.workspaceRoot,
    harnessName: effective.harnessName, model: effective.modelId,
    prompt,
    roleContent: role?.content ?? null,
    roleFilePath: role ? resolve(worktreePath, BUILDER_ROLE_FILE) : null,
    startPty: () => startBuilderSession(
      config, builderId, worktreePath, effective.command,
      prompt, role?.content ?? null, role?.source ?? null,
      undefined, effective,
    ),
  });

  persistSpawnedBuilder({
    id: builderId, name: `Protocol: ${protocolName}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: 'protocol', protocolName,
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    harness: effective.harnessName,
    model: effective.modelId,
    ...identity,
  }, { worktreePath, projectId: builderId, projectName: worktreeName });

  logSpawnSuccess(`Builder ${builderId}`, identity);
}

/**
 * Spawn a bare shell session (no worktree, no prompt)
 */
async function spawnShell(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  const shortId = generateShortId();
  const shellId = `shell-${shortId}`;

  logger.header(`Spawning Shell ${shellId}`);

  await ensureDirectories(config);
  await checkDependencies();

  // Issue #2: shell mode has no launch script, so the model fragment is folded onto
  // the raw command here rather than in startBuilderSession.
  const shellCmd = selection.modelScriptFragment
    ? `${selection.command} ${selection.modelScriptFragment}`
    : selection.command;
  const { terminalId } = await startShellSession(config, shortId, shellCmd);

  upsertBuilder({
    id: shellId, name: 'Shell session',
    status: 'implementing', phase: 'interactive',
    worktree: '', branch: '', type: 'shell', terminalId,
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    // Shell mode has no worktree, so nothing to resume into — the spawn-time
    // selection is the only one there is.
    harness: selection.harnessName,
    model: selection.modelId,
  });

  logSpawnSuccess(`Shell ${shellId}`, { terminalId });
}

/**
 * Spawn a worktree session (has worktree/branch, but no initial prompt)
 */
async function spawnWorktree(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  const shortId = generateShortId();
  const builderId = `worktree-${shortId}`;
  const branchName = `builder/worktree-${shortId}`;
  const worktreePath = resolve(config.buildersDir, builderId);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} Worktree ${builderId}`);
  logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);

  await ensureDirectories(config);
  await checkDependencies();

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else {
    await createWorktree(config, branchName, worktreePath);
  }

  const role = options.noRole ? null : loadRolePrompt(config, 'builder');

  logger.info('Creating terminal session...');
  const effective = selectionForResume(options, config, builderId, selection);
  const scriptContent = buildWorktreeLaunchScript(worktreePath, effective.command, role, config.workspaceRoot, effective);
  const scriptPath = resolve(worktreePath, '.builder-start.sh');
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  const identity = await launchSpawnedBuilder({
    existing: options.resume ? getBuilder(builderId, config.workspaceRoot) : null,
    builderId, worktreePath, branch: branchName,
    workspaceRoot: config.workspaceRoot,
    harnessName: effective.harnessName, model: effective.modelId,
    launchScript: scriptPath,
    // A worktree spawn has no prompt — its payload is the launch script — but it DOES have a
    // role, baked into that script above. The thread path has no script to bake it into, so
    // without these it is the one spawn form that comes up with no role at all while the PTY
    // form gets one. `DriverThread` holds a pending role and joins it onto whichever turn
    // starts first, so forwarding it works even with no initial prompt.
    roleContent: role?.content ?? null,
    roleFilePath: role ? resolve(worktreePath, BUILDER_ROLE_FILE) : null,
    startPty: async () => {
      logger.info('Creating PTY terminal session for worktree...');
      const session = await createPtySession(
        config,
        '/bin/bash',
        [scriptPath],
        worktreePath,
        { workspacePath: config.workspaceRoot, type: 'builder', roleId: builderId },
      );
      logger.info(`Worktree terminal session created: ${session.terminalId}`);
      return session;
    },
  });

  persistSpawnedBuilder({
    id: builderId, name: 'Worktree session',
    status: 'implementing', phase: 'interactive',
    worktree: worktreePath, branch: branchName, type: 'worktree',
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    harness: effective.harnessName,
    model: effective.modelId,
    ...identity,
  });

  logSpawnSuccess(`Worktree ${builderId}`, identity);
}

/**
 * Spawn builder for an issue-driven protocol (BUGFIX, PIR, …).
 *
 * Implements the shared spawn pattern: fetch the GitHub issue, derive the
 * builder ID / worktree / branch from `prefix`, run pre-spawn hooks, create
 * or resume the worktree, initialize porch, render the builder prompt from
 * the protocol's template, and start the PTY session.
 *
 * Each calling protocol owns a one-line wrapper (`spawnBugfix`, `spawnPir`)
 * that passes its prefix. The dispatcher (`getSpawnMode` + `handlers`) routes
 * each protocol to its dedicated wrapper — there is no shared dispatch entry.
 */
async function spawnIssueDrivenBuilder(
  options: SpawnOptions,
  config: Config,
  prefix: 'bugfix' | 'pir',
  selection: AgentSelection,
): Promise<void> {
  const protocolLabel = prefix === 'pir' ? 'PIR' : 'Bugfix';
  const issueNumber = options.issueNumber!;
  const protocol = await resolveIssueProtocol(options, config);
  const forgeConfig = loadForgeConfig(config.workspaceRoot);

  logger.header(`${options.resume ? 'Resuming' : 'Spawning'} ${protocolLabel} Builder for Issue #${issueNumber}`);

  // Fetch issue from GitHub
  logger.info('Fetching issue from GitHub...');
  const issue = await fetchGitHubIssue(issueNumber, { cwd: config.workspaceRoot, forgeConfig });

  const builderId = buildAgentName(prefix, String(issueNumber));

  // When resuming, find the existing worktree by issue number pattern
  // instead of recomputing from the current title (which may have changed).
  let worktreeName: string;
  // Spec 653: worktree path uses project ID only — no title suffix.
  let branchName: string;
  if (options.branch) {
    branchName = options.branch;
    worktreeName = `${prefix}-${issueNumber}`;
  } else if (options.resume) {
    // Migration: try ID-only path first, fall back to old title-based path
    const idOnlyName = `${prefix}-${issueNumber}`;
    const idOnlyPath = resolve(config.buildersDir, idOnlyName);
    if (existsSync(idOnlyPath)) {
      worktreeName = idOnlyName;
    } else {
      const existing = findExistingIssueWorktree(config.buildersDir, prefix, issueNumber);
      if (existing) {
        worktreeName = existing;
      } else {
        worktreeName = idOnlyName;
      }
    }
    branchName = `builder/${worktreeName}`;
  } else {
    worktreeName = `${prefix}-${issueNumber}`;
    branchName = `builder/${worktreeName}`;
  }

  const worktreePath = resolve(config.buildersDir, worktreeName);

  const protocolDef = loadProtocol(config, protocol);
  const mode = resolveMode(options, protocolDef);

  logger.kv('Title', issue.title);
  if (options.branch) logger.kv('Existing Branch', branchName);
  else logger.kv('Branch', branchName);
  logger.kv('Worktree', worktreePath);
  logger.kv('Protocol', protocol.toUpperCase());
  logger.kv('Mode', mode.toUpperCase());

  // Execute pre-spawn hooks (skip in resume and branch modes)
  if (!options.resume && !options.branch) {
    if (protocolDef?.hooks?.['pre-spawn']) {
      await executePreSpawnHooks(protocolDef, {
        issueNumber,
        issue,
        worktreePath,
        force: options.force,
        noComment: options.noComment,
        forgeConfig,
      });
    } else {
      // Fallback: hardcoded behavior for backwards compatibility
      await checkBugfixCollisions(issueNumber, worktreePath, issue, !!options.force, forgeConfig);
      if (!options.noComment) {
        logger.info('Commenting on issue...');
        try {
          await executeForgeCommand('issue-comment', {
            CODEV_ISSUE_ID: String(issueNumber),
            CODEV_COMMENT_BODY: 'On it! Working on a fix now.',
          }, { forgeConfig, raw: true });
        } catch {
          logger.warn('Warning: Failed to comment on issue (continuing anyway)');
        }
      }
    }
  }

  await ensureDirectories(config);
  await checkDependencies();

  // Porch project ID:
  //   - PIR uses the bare issue number (matches SPIR's convention, so
  //     artifacts land at codev/{plans,reviews}/<N>-<slug>.md).
  //   - BUGFIX uses <prefix>-<N> (historical, kept untouched).
  //
  // Distinct from the worktree dir (.builders/<prefix>-<N>/), the branch
  // (builder/<prefix>-<N>), and the Tower agent name (builder-<prefix>-<N>).
  // All four are namespaced differently — porch state ID lines up with
  // artifacts; the other three encode protocol for collision-free worktree
  // / branch / agent management.
  const porchProjectId = prefix === 'pir' ? String(issueNumber) : `${prefix}-${issueNumber}`;

  if (options.resume) {
    validateResumeWorktree(worktreePath);
  } else if (options.branch) {
    await createWorktreeFromBranch(config, branchName, worktreePath, { remote: options.remote });
    const slug = slugify(issue.title);
    await initPorchInWorktree(worktreePath, protocol, porchProjectId, slug);
  } else {
    await createWorktree(config, branchName, worktreePath);
    const slug = slugify(issue.title);
    await initPorchInWorktree(worktreePath, protocol, porchProjectId, slug);
  }

  const templateContext: TemplateContext = {
    protocol_name: protocol.toUpperCase(), mode,
    mode_soft: mode === 'soft', mode_strict: mode === 'strict',
    // The porch project ID — what `porch next/done/approve` expects.
    // NOT the builder agent name (which includes the `builder-` prefix).
    project_id: porchProjectId,
    input_description: `work for GitHub Issue #${issueNumber}`,
    issue: { number: issueNumber, title: issue.title, body: issue.body || '(No description provided)' },
  };
  if (options.branch) {
    templateContext.existing_branch = options.branch;
  }
  const prompt = buildPromptFromTemplate(config, protocol, templateContext);
  const resumeNotice = options.resume ? `\n${buildResumeNotice(builderId)}\n` : '';
  const branchNotice = options.branch
    ? `\n## Existing Branch\nYou are continuing work on existing branch \`${options.branch}\`. This branch may have commits from another contributor. Review the existing commits before making changes.\n`
    : '';
  const builderPrompt = `You are a Builder. Read codev/roles/builder.md for your full role definition.\n${resumeNotice}${branchNotice}\n${prompt}`;

  const effective = selectionForResume(options, config, builderId, selection);
  // Issue #2: discovery must use the SELECTION's harness. Reading the config
  // harness here would look for a claude session under a codex builder.
  const resume = discoverResumeSession(worktreePath, options.resume, effective.provider);
  const role = options.noRole ? null : loadRolePrompt(config, 'builder');

  const identity = await launchSpawnedBuilder({
    existing: options.resume ? getBuilder(builderId, config.workspaceRoot) : null,
    builderId, worktreePath, branch: branchName,
    workspaceRoot: config.workspaceRoot,
    harnessName: effective.harnessName, model: effective.modelId,
    prompt: builderPrompt,
    roleContent: role?.content ?? null,
    roleFilePath: role ? resolve(worktreePath, BUILDER_ROLE_FILE) : null,
    startPty: () => startBuilderSession(
      config, builderId, worktreePath, effective.command,
      builderPrompt, role?.content ?? null, role?.source ?? null,
      resume, effective,
    ),
  });

  persistSpawnedBuilder({
    id: builderId,
    name: `${protocolLabel} #${issueNumber}: ${issue.title.substring(0, 40)}${issue.title.length > 40 ? '...' : ''}`,
    status: 'implementing', phase: 'init',
    worktree: worktreePath, branch: branchName, type: prefix, issueNumber,
    spawnedByArchitect: SPAWNING_ARCHITECT_NAME,
    harness: effective.harnessName,
    model: effective.modelId,
    ...identity,
  }, { worktreePath, projectId: porchProjectId, projectName: slugify(issue.title) });

  logSpawnSuccess(`${protocolLabel} builder for issue #${issueNumber}`, identity, mode);
}

/** Spawn a BUGFIX builder via the shared issue-driven helper. */
async function spawnBugfix(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  return spawnIssueDrivenBuilder(options, config, 'bugfix', selection);
}

/** Spawn a PIR builder via the shared issue-driven helper. */
async function spawnPir(options: SpawnOptions, config: Config, selection: AgentSelection): Promise<void> {
  return spawnIssueDrivenBuilder(options, config, 'pir', selection);
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Abort the spawn when the configured builder command has no render-gate profile
 * (Issue #4, acceptance criterion 4).
 *
 * `afx send` is mailbox-first: it delivers only onto a screen the render gate has
 * classified as an empty prompt, and classification needs a per-app profile measured
 * from real captured frames. A harness without one holds every message forever with
 * reason `no-profile`. That failure is invisible at spawn time — the builder starts,
 * the terminal renders, the row appears — and only shows up when someone tries to talk
 * to it, so it is caught here instead, before any worktree, terminal or db state exists.
 *
 * Checked against the resolved builder COMMAND (not the harness name), because the gate
 * identifies apps that way too — the same `resolveProfile` table, so the two agree on what
 * is deliverable. They are not literally one lookup: at runtime the gate sees the
 * `.builder-start.sh` wrapper and relies on the delivery wiring re-extracting the agent
 * command from it, so the agreement rests on both sides naming the same agent, not on a
 * single call site. Applies to custom harnesses as well: an unmeasured custom
 * agent is exactly the case that produces an unmessageable builder. There is no bypass
 * flag, matching the fail-closed precedent `assertBuilderHarnessNotRetired` set — the
 * fix is to measure a profile, not to skip the check.
 */
function assertBuilderHarnessHasGateProfile(selection: AgentSelection): void {
  // Issue #2: checked against THIS SPAWN's command. Reading the workspace default
  // here instead would let `--harness opencode` in a claude-configured workspace
  // pass a check on the wrong binary entirely.
  const builderCmd = selection.command;
  if (hasGateProfile(builderCmd)) return;
  fatal(
    `Builder harness "${builderCmd}" has no render-gate profile.\n\n` +
    '  `afx send` delivers a message only onto a prompt the render gate has proven\n' +
    '  empty, and that needs a profile measured from real captured frames of the\n' +
    '  agent\'s TUI. Without one, every message to this builder would be held\n' +
    '  forever with reason "no-profile" — a builder you can spawn but never message.\n\n' +
    '  Builder harnesses with a measured profile: claude, codex, opencode.\n\n' +
    '  Aborting before any worktree, terminal or builder state is created.'
  );
}

/**
 * Recover the (harness, model) a builder was spawned with, for `--resume` (Issue #2).
 *
 * Every spawn path recomputes its agent command from workspace config, including
 * the resume path. That was harmless while the agent WAS the config value, but
 * once the pair is chosen per spawn a resume would silently drop it and relaunch
 * the builder on the workspace default — no error, no warning, just a different
 * model than the one it has been working with. A flag that quietly stops applying
 * is worse than no flag, so the pair is read back from the row written at spawn.
 *
 * An explicit `--harness`/`--model` on the resume command still wins: that is how
 * you deliberately move a builder onto a different pair. A row with neither value
 * (spawned before this existed, or spawned with no flags) keeps today's behaviour.
 *
 * Exported for testing, matching `discoverResumeSession` above.
 *
 * The recovered pair is re-validated, not trusted: the stored harness may since
 * have been retired, or lost its model selector. Failing loudly on relaunch beats
 * resurrecting a builder onto an agent that no longer resolves.
 */
export function selectionForResume(
  options: SpawnOptions,
  config: Config,
  builderId: string,
  selection: AgentSelection,
): AgentSelection {
  if (!options.resume) return selection;
  if (options.harness || options.model) return selection;

  const stored = getBuilder(builderId, config.workspaceRoot);
  if (!stored || (!stored.harness && !stored.model)) return selection;

  // Coerce to undefined explicitly. `resolveBuilderSelection` treats "a model was
  // requested" as `!== undefined`, so a null slipping through (the raw column value
  // for a builder spawned with a harness but no model) would be validated as a
  // model id and throw on resume.
  const recovered = resolveBuilderSelection(
    { harness: stored.harness ?? undefined, model: stored.model ?? undefined },
    config.workspaceRoot,
  );
  assertHarnessCommandAgrees(recovered);
  assertBuilderHarnessHasGateProfile(recovered);
  logger.info(
    `Resuming on the recorded harness/model: ${recovered.harnessName}` +
    `${recovered.modelId ? ` / ${recovered.modelId}` : ''}`,
  );
  return recovered;
}

/**
 * Spawn a new builder
 */
export async function spawn(options: SpawnOptions): Promise<void> {
  validateSpawnOptions(options);

  const config = getConfig();

  // Refuse to spawn if the main worktree has uncommitted changes to tracked files.
  // Builders work in git worktrees branched from HEAD — uncommitted modifications
  // (specs, plans, codev updates) won't be visible to the builder.
  //
  // Skip this check entirely for:
  //   - --force: explicit override
  //   - --resume: worktree already exists with its own branch
  //   - --task: ephemeral tasks don't depend on committed specs/plans
  if (!options.force && !options.resume && !options.task && !options.branch) {
    if (await hasUncommittedTrackedChanges(config.workspaceRoot)) {
      fatal(
        'Uncommitted changes to tracked files detected in main worktree.\n\n' +
        '  Builders branch from HEAD, so uncommitted modifications (specs,\n' +
        '  plans, codev updates) will NOT be visible to the builder.\n\n' +
        '  Untracked files are ignored — only modifications and staged\n' +
        '  changes to tracked files trigger this check.\n\n' +
        '  Please commit or stash your changes first, then retry.\n' +
        '  Use --force to skip this check.'
      );
    }
  }

  // Prune stale worktrees before spawning to prevent "can't find session" errors
  try {
    await run('git worktree prune', { cwd: config.workspaceRoot });
  } catch {
    // Non-fatal - continue with spawn even if prune fails
  }

  const mode = getSpawnMode(options);

  // Fail closed on a retired builder harness (Issue #1338) BEFORE dispatching to
  // any handler, for EVERY mode. Worktree modes create worktree/porch/db state,
  // and `createWorktree` itself resolves the builder harness (spawn-worktree.ts),
  // so a guard placed below dispatch would orphan a half-built worktree. `shell`
  // mode has no worktree, but `spawnShell` still runs `commands.builder` via
  // `startShellSession` and persists a shell row — so a retired `gemini`
  // shell.builder would otherwise launch the retired CLI AND leave a shell row.
  // The retirement decision (including the custom-harness escape hatch) is
  // delegated to `getBuilderHarness`; only the retirement aborts here — an
  // unknown-harness name still surfaces at its existing resolution call site, so
  // behavior is unchanged for every supported harness and every mode.
  assertBuilderHarnessNotRetired(config.workspaceRoot);

  // Issue #2: resolve the (harness, model) pair for THIS spawn — an explicit
  // --harness/--model, else exactly what workspace config resolved before. Done
  // here, above the mode dispatch, so every pre-flight below judges the agent that
  // will actually launch, and so a bad pair (unknown harness, retired harness,
  // malformed model id, or a model for a harness with no model selector) throws
  // before any worktree, terminal, porch or db state exists. There is no bypass,
  // matching the fail-closed precedent of the two asserts around it.
  const selection = resolveBuilderSelection(
    { harness: options.harness, model: options.model },
    config.workspaceRoot,
  );
  assertHarnessCommandAgrees(selection);

  // Issue #4: and fail closed on a builder harness the render gate cannot classify,
  // at the same point and for the same reason. Without a profile, `afx send` holds
  // every message forever with reason `no-profile`, so the spawn would otherwise
  // succeed into a builder that runs, looks healthy, and can never be messaged —
  // a silent failure discovered only when someone tries to talk to it.
  assertBuilderHarnessHasGateProfile(selection);

  const handlers: Record<BuilderType, () => Promise<void>> = {
    spec: () => spawnSpec(options, config, selection),
    bugfix: () => spawnBugfix(options, config, selection),
    pir: () => spawnPir(options, config, selection),
    task: () => spawnTask(options, config, selection),
    protocol: () => spawnProtocol(options, config, selection),
    shell: () => spawnShell(options, config, selection),
    worktree: () => spawnWorktree(options, config, selection),
  };
  await handlers[mode]();
}

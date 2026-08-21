/**
 * Forge concept command dispatcher.
 *
 * Routes forge operations (issue fetch, PR list, etc.) through configurable
 * external commands. Default commands wrap the `gh` CLI for GitHub repos.
 * Projects override commands via the `forge` section in .codev/config.json.
 *
 * Concept commands are executed via shell (`sh -c`) to support pipes,
 * redirects, and variable expansion in user-configured commands.
 * Environment variables (CODEV_*) are set before invocation.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig as loadCodevConfig } from './config.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the path to a provider's on-disk concept script.
 * Scripts live at `scripts/forge/<provider>/<concept>.sh` relative to the package root.
 * At runtime, __dirname is `dist/lib/` — the package root is two levels up.
 */
function resolveScriptPath(provider: string, concept: string): string {
  return resolve(__dirname, '..', '..', 'scripts', 'forge', provider, `${concept}.sh`);
}

/** Default maxBuffer for forge commands (10MB). Prevents truncation for large diffs. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Default wall-clock ceiling for a forge command (30s).
 *
 * The scripts carry their own, shorter watchdog (CODEV_FORGE_TIMEOUT, default
 * 60s in scripts/forge/_timeout.sh) so that a stalled CLI surfaces as a NAMED
 * timeout rather than as this outer kill, which can only report that something
 * died. Both exist: the inner one explains, the outer one guarantees.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

// =============================================================================
// Types
// =============================================================================

/** Forge config from .codev/config.json `forge` section (concept overrides + optional provider). */
export type ForgeConfig = Record<string, string | null> & { provider?: string };

/** Options for forge command execution. */
export interface ForgeCommandOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Workspace root for loading .codev/config.json (only used if forgeConfig not provided). */
  workspaceRoot?: string;
  /** Pre-loaded forge config. Avoids repeated .codev/config.json reads. */
  forgeConfig?: ForgeConfig | null;
  /** If true, return stdout as raw string instead of parsing as JSON. */
  raw?: boolean;
  /** Maximum stdout buffer size in bytes. Defaults to 10MB. */
  maxBuffer?: number;
  /** Wall-clock ceiling in ms. Defaults to 30s. */
  timeoutMs?: number;
}

// =============================================================================
// Known concept names
// =============================================================================

const KNOWN_CONCEPTS = [
  'issue-view', 'pr-list', 'issue-list', 'issue-search', 'issue-comment', 'pr-exists',
  'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
  'on-it-timestamps', 'pr-create', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff',
  'auth-status', 'repo-archive',
  // CI concepts (#13), tiered so the cheap question stays cheap: ci-runs and
  // ci-run-view answer "did it pass" and "which job" without touching a log,
  // ci-failures fetches exactly one job's log and returns a bounded extract,
  // and ci-run-log is the deliberate raw-window escape hatch. Only the last two
  // ever read log bytes.
  'ci-runs', 'ci-run-view', 'ci-failures', 'ci-run-log',
] as const;

// =============================================================================
// Default concept commands — resolved lazily from on-disk scripts
// =============================================================================

let _defaultCommands: Record<string, string> | null = null;

/**
 * Build default commands from on-disk scripts (github provider).
 * Each concept maps to `scripts/forge/github/<concept>.sh`.
 * Lazily computed and cached.
 */
function getDefaultCommands(): Record<string, string> {
  if (_defaultCommands) return _defaultCommands;
  _defaultCommands = {};
  for (const concept of KNOWN_CONCEPTS) {
    _defaultCommands[concept] = resolveScriptPath('github', concept);
  }
  return _defaultCommands;
}

// =============================================================================
// Provider presets
// =============================================================================

/**
 * Build a provider preset from on-disk scripts.
 * Concepts without a script file are omitted (fall through to default).
 * Explicitly disabled concepts are set to null.
 */
function buildPresetFromScripts(provider: string, disabledConcepts: string[] = []): Record<string, string | null> {
  const preset: Record<string, string | null> = {};
  for (const concept of KNOWN_CONCEPTS) {
    if (disabledConcepts.includes(concept)) {
      preset[concept] = null;
      continue;
    }
    const scriptPath = resolveScriptPath(provider, concept);
    if (existsSync(scriptPath)) {
      preset[concept] = scriptPath;
    }
  }
  return preset;
}

let _providerPresets: Record<string, Record<string, string | null>> | null = null;

/**
 * Built-in presets for common forges. Resolved lazily from on-disk scripts.
 *
 * NOTE: Non-GitHub presets are best-effort. Their output schemas may not conform
 * to the contracts in forge-contracts.ts. Consumers must handle null returns
 * gracefully since JSON parse failures now return null instead of raw strings.
 */
function getProviderPresets(): Record<string, Record<string, string | null>> {
  if (_providerPresets) return _providerPresets;
  _providerPresets = {
    github: getDefaultCommands(),
    // The ci-* concepts are DISABLED for gitlab, not merely unimplemented. A
    // concept with no script falls through to the github default, so leaving
    // them out would make a GitLab repo silently run `gh run list` against
    // whatever GitHub remote gh happens to resolve — the silent-fallthrough
    // class #1455 closed. Issue #13 asks for gitlab to "degrade loudly, not
    // silently"; this is what makes it loud.
    gitlab: buildPresetFromScripts('gitlab', [
      'team-activity', 'on-it-timestamps',
      'ci-runs', 'ci-run-view', 'ci-failures', 'ci-run-log',
    ]),
    // pr-search and pr-diff were disabled here until #12 shipped gitea scripts
    // for them. team-activity and on-it-timestamps stay disabled and are not
    // coming: both are `gh api graphql` pass-throughs and Forgejo has no
    // GraphQL. Their callers say so out loud rather than degrading quietly —
    // see fetchOnItTimestamps and fetchTeamGitHubData.
    gitea: buildPresetFromScripts('gitea', ['team-activity', 'on-it-timestamps']),
    // pr-create is explicitly disabled (not just "no script") — Linear has no PR
    // concept of its own, and without this it silently falls through to the
    // github default (`gh pr create`) instead of failing loudly. That's the
    // exact silent-fallthrough bug class #1455 closes.
    linear: buildPresetFromScripts('linear', [
      'team-activity', 'on-it-timestamps', 'pr-create',
      // Linear has no CI of its own, and the same silent fallthrough applies.
      'ci-runs', 'ci-run-view', 'ci-failures', 'ci-run-log',
    ]),
  };
  return _providerPresets;
}

/** Get known provider names. */
export function getKnownProviders(): string[] {
  return Object.keys(getProviderPresets());
}

/** Resolution source for a concept command. */
export type ConceptSource = 'override' | 'preset' | 'default' | 'disabled';

export interface ConceptResolution {
  concept: string;
  command: string | null;
  source: ConceptSource;
  executable: string | null;
}

/**
 * Resolve every known concept with its source and executable.
 * Used by `codev doctor` for full concept reporting.
 */
export function resolveAllConcepts(forgeConfig?: ForgeConfig | null): ConceptResolution[] {
  const concepts = Object.keys(getDefaultCommands());
  return concepts.map((concept) => {
    // Check manual override first
    if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
      const cmd = forgeConfig[concept];
      if (cmd === null) {
        return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
      }
      return { concept, command: cmd, source: 'override' as ConceptSource, executable: extractExecutable(cmd) };
    }

    // Check provider preset
    if (forgeConfig?.provider) {
      const preset = getProviderPresets()[forgeConfig.provider];
      if (preset && concept in preset) {
        const cmd = preset[concept];
        if (cmd === null) {
          return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
        }
        return { concept, command: cmd, source: 'preset' as ConceptSource, executable: extractExecutable(cmd) };
      }
    }

    // Default
    const cmd = getDefaultCommands()[concept] ?? null;
    return { concept, command: cmd, source: 'default' as ConceptSource, executable: cmd ? extractExecutable(cmd) : null };
  });
}

/**
 * Extract the executable name from a command string or script path.
 *
 * For script paths (ending in .sh): reads the script and finds the first
 * substantive command (after `exec`, or in `if/then` blocks).
 *
 * For inline commands: handles `if [ ... ]; then cmd ...` patterns and pipes.
 */
/** Shell builtins and keywords that are never the executable a concept needs on PATH. */
const SHELL_BUILTINS = ['if', 'then', 'else', 'fi', 'test', '[', '[[', 'set', 'export', 'readonly', 'local', 'shift', ':', '.', 'source'];

function extractExecutable(command: string): string | null {
  const trimmed = command.trim();

  // Script path: read and extract the underlying tool
  if (trimmed.endsWith('.sh') && existsSync(trimmed)) {
    try {
      const content = readFileSync(trimmed, 'utf-8');
      // An explicit `# forge-executable: <tool>` declaration wins. The heuristic
      // below reads the first substantive line, which is wrong for any script
      // that opens with `set -e` or an input guard — it would tell `codev
      // doctor` to look for `set` or `echo` instead of `gh`/`tea`/`glab`, and a
      // missing forge CLI would go unreported (#1455).
      const declared = content.match(/^#\s*forge-executable:\s*(\S+)/m);
      if (declared) return declared[1];
      // Look for `exec <tool>` or first non-comment, non-shebang, non-blank line
      for (const line of content.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#') || l.startsWith('if') || l.startsWith('else') || l.startsWith('fi') || /^\w+=/.test(l)) continue;
        const execMatch = l.match(/^exec\s+(\S+)/);
        if (execMatch) return execMatch[1];
        // First substantive command. Shell builtins are skipped, not returned:
        // a script opening with `set -e` would otherwise report `set` as its
        // executable, and `codev doctor` would then warn that `set` is missing
        // instead of checking for the real CLI (#1455).
        const token = l.split(/\s+/)[0];
        if (token && !SHELL_BUILTINS.includes(token)) {
          return token;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Inline command: extract first real executable
  // Shell conditional: extract first command after "then"
  const thenMatch = trimmed.match(/then\s+(\S+)/);
  if (thenMatch) return thenMatch[1];
  // Pipe: first command
  const first = trimmed.split(/[|;]/).map(s => s.trim())[0];
  // Skip shell builtins
  const token = first.split(/\s+/)[0];
  if (SHELL_BUILTINS.includes(token)) return null;
  return token || null;
}

// =============================================================================
// Configuration loading
// =============================================================================

/**
 * Load forge configuration from .codev/config.json (via unified config loader).
 * Returns the forge section or null if not configured.
 *
 * Prefer passing forge config directly via ForgeCommandOptions.forgeConfig
 * when config is already loaded (e.g., from loadConfig in lib/config.ts).
 */
export function loadForgeConfig(workspaceRoot: string): ForgeConfig | null {
  const config = loadCodevConfig(workspaceRoot);
  return (config.forge as ForgeConfig) ?? null;
}

/** Resolve forge config from options: explicit > loaded from workspace > loaded from cwd > null. */
function resolveForgeConfig(options?: ForgeCommandOptions): ForgeConfig | null {
  if (options?.forgeConfig !== undefined) return options.forgeConfig;
  if (options?.workspaceRoot) return loadForgeConfig(options.workspaceRoot);
  if (options?.cwd) return loadForgeConfig(options.cwd);
  return null;
}

/**
 * Get the command string for a concept.
 * Resolution order: manual concept override > provider preset > default (github).
 * Returns null if concept is explicitly disabled (set to null in config).
 */
export function getForgeCommand(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): string | null {
  // Check manual concept overrides first (excluding 'provider' key)
  if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
    return forgeConfig[concept]; // null means explicitly disabled
  }

  // Check provider preset
  if (forgeConfig?.provider) {
    const preset = getProviderPresets()[forgeConfig.provider];
    if (preset && concept in preset) {
      return preset[concept]; // null means not supported by this provider
    }
  }

  // Fall back to default (github)
  return getDefaultCommands()[concept] ?? null;
}

/**
 * Check if a concept is explicitly disabled (set to null in config).
 */
export function isConceptDisabled(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): boolean {
  if (!forgeConfig) return false;
  return concept in forgeConfig && forgeConfig[concept] === null;
}

/**
 * Explain, in one sentence, why a concept has no command — for a human reading
 * a terminal, not for a log file.
 *
 * A concept can be unavailable two ways that look identical to a caller and are
 * not identical to a user: the project turned it off, or the forge provider
 * never had it. Naming the provider is the difference between "why is this
 * panel empty" and "right, Forgejo has no GraphQL".
 */
export function describeUnavailableConcept(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): string {
  const provider = forgeConfig?.provider;
  if (forgeConfig && concept !== 'provider' && concept in forgeConfig && forgeConfig[concept] === null) {
    return `the \`${concept}\` forge concept is disabled in .codev/config.json`;
  }
  if (provider) {
    return `the \`${concept}\` forge concept is not available for provider "${provider}"`;
  }
  return `the \`${concept}\` forge concept has no command configured`;
}

/** Concepts already warned about, so a per-poll code path warns once per process. */
const _warnedConcepts = new Set<string>();

/**
 * Warn on stderr, once per concept per process, that a concept is unavailable
 * and what that costs.
 *
 * Once per process rather than once per call: these sit on polled paths (the
 * overview refreshes every 30s), and a warning printed on every poll is noise
 * that trains people to ignore it — which is the same silence it was meant to
 * break, arrived at by a different road.
 */
export function warnConceptUnavailable(
  concept: string,
  forgeConfig: ForgeConfig | null | undefined,
  consequence: string,
): void {
  if (_warnedConcepts.has(concept)) return;
  _warnedConcepts.add(concept);
  console.error(`Warning: ${describeUnavailableConcept(concept, forgeConfig)} — ${consequence}.`);
}

/** Test seam: forget which concepts have been warned about. */
export function _resetConceptWarnings(): void {
  _warnedConcepts.clear();
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute a forge concept command asynchronously.
 *
 * Sets CODEV_* environment variables, executes the configured command
 * via shell, and parses stdout as JSON. Returns null on failure.
 *
 * @param concept - The concept name (e.g., 'issue-view', 'pr-list')
 * @param env - Additional environment variables to set (CODEV_* prefix recommended)
 * @param options - Execution options
 * @returns Parsed JSON from stdout, raw string for non-JSON concepts, or null on failure
 */
export async function executeForgeCommand(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): Promise<unknown | null> {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  const forgeEnv = buildForgeEnv(forgeConfig);

  try {
    const { stdout } = await execAsync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...forgeEnv, ...env },
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err);
    return null;
  }
}

/** Outcome of executeForgeCommandDetailed — every failure mode kept distinct. */
export interface ForgeCommandResult {
  /** True when the command exited 0. */
  ok: boolean;
  /** Parsed stdout (JSON, or the raw string when `raw` is set). Null if unparseable or empty. */
  data: unknown | null;
  /** Raw stdout, kept even on failure — the ci-* concepts print their error envelope there. */
  stdout: string;
  stderr: string;
  /** Process exit code, or null when the process was killed by a signal. */
  exitCode: number | null;
  /** True when the command was killed for exceeding the timeout. */
  timedOut: boolean;
  /** True when the concept has no command at all (disabled, or no provider script). */
  unavailable: boolean;
  durationMs: number;
}

/**
 * Execute a forge concept command and report HOW it went, not merely whether.
 *
 * `executeForgeCommand` returns `null` for every failure mode: a timeout, a
 * non-zero exit, unparseable output and a disabled concept are one value. That
 * ambiguity has now cost this project several rounds — #12 shipped a fix for
 * `pr-exists` returning a null that porch read as "no PR exists", and #17 and
 * #8 both turned a stalled call into a generic failure with nothing naming the
 * stall. A caller that needs to tell those apart uses this instead.
 *
 * Note in particular that `stdout` is returned even when `ok` is false. The CI
 * concepts print a structured error envelope on stdout precisely so that the
 * class of failure survives; discarding stdout on a non-zero exit would throw
 * it away at the last step.
 *
 * Additive: `executeForgeCommand` is unchanged and no existing caller moves.
 */
export async function executeForgeCommandDetailed(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): Promise<ForgeCommandResult> {
  const started = Date.now();
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return {
      ok: false, data: null, stdout: '', stderr: '',
      exitCode: null, timedOut: false, unavailable: true,
      durationMs: Date.now() - started,
    };
  }

  const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forgeEnv = buildForgeEnv(forgeConfig);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...forgeEnv, ...env },
      timeout,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
    return {
      ok: true, data: parseOutput(stdout, options?.raw),
      stdout: String(stdout), stderr: String(stderr),
      exitCode: 0, timedOut: false, unavailable: false,
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    logDebug(concept, err);
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    // `killed` plus a signal is how Node reports the timeout it enforced —
    // verified during #12 against a command whose grandchild held the stdout
    // pipe. An exit code alone cannot be read as a timeout: a killed process
    // can still exit with a status, and a script that times out INTERNALLY (the
    // shell watchdog in scripts/forge/_timeout.sh) exits non-zero with its own
    // timeout envelope on stdout, which is why stdout is preserved below.
    const timedOut = e.killed === true && typeof e.signal === 'string';
    return {
      ok: false,
      data: e.stdout ? parseOutput(e.stdout, options?.raw) : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      exitCode: typeof e.code === 'number' ? e.code : null,
      timedOut,
      unavailable: false,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Execute a forge concept command synchronously.
 *
 * Same as executeForgeCommand but blocks until completion.
 * Use sparingly — prefer the async variant.
 */
export function executeForgeCommandSync(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): unknown | null {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  const forgeEnv = buildForgeEnv(forgeConfig);

  try {
    const stdout = execSync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...forgeEnv, ...env },
      encoding: 'utf-8',
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err, true);
    return null;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

const _knownConceptSet = new Set<string>(KNOWN_CONCEPTS);

/**
 * Build environment variables from non-concept forge config keys.
 * E.g., `forge.linear-team: "ENG"` → `CODEV_LINEAR_TEAM=ENG`.
 */
function buildForgeEnv(forgeConfig: ForgeConfig | null): Record<string, string> {
  if (!forgeConfig) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(forgeConfig)) {
    if (key === 'provider' || _knownConceptSet.has(key) || value === null) continue;
    const envKey = 'CODEV_' + key.toUpperCase().replace(/-/g, '_');
    result[envKey] = value;
  }
  return result;
}

/** Parse command stdout: try JSON when raw=false (null on parse failure), raw string otherwise. */
function parseOutput(stdout: string, raw?: boolean): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  if (raw) return trimmed;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not valid JSON — return null so downstream code doesn't cast a raw
    // string to typed objects (e.g. IssueViewResult, PrListItem[]).
    return null;
  }
}

/** Log concept failure at debug level. */
function logDebug(concept: string, err: unknown, sync = false): void {
  if (process.env.CODEV_DEBUG) {
    const msg = err instanceof Error ? err.message : String(err);
    const suffix = sync ? ' (sync)' : '';
    console.warn(`[forge] concept '${concept}'${suffix} failed: ${msg}`);
  }
}

// =============================================================================
// Convenience helpers
// =============================================================================

/**
 * Get the list of all known concept names.
 */
export function getKnownConcepts(): string[] {
  return Object.keys(getDefaultCommands());
}

/**
 * Get the default command for a concept (ignoring user config).
 * Useful for documentation and doctor checks.
 */
export function getDefaultCommand(concept: string): string | null {
  return getDefaultCommands()[concept] ?? null;
}

/**
 * Validate forge configuration.
 * Returns an array of diagnostic messages.
 * Used by `codev doctor`.
 */
export function validateForgeConfig(
  forgeConfig: ForgeConfig,
): { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] {
  const results: { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] = [];

  // Report provider if set
  if (forgeConfig.provider) {
    const providerName = forgeConfig.provider;
    if (getProviderPresets()[providerName]) {
      results.push({ concept: 'provider', status: 'provider', message: `Provider: ${providerName}` });
    } else {
      results.push({ concept: 'provider', status: 'unknown_concept', message: `Unknown provider '${providerName}' (known: ${Object.keys(getProviderPresets()).join(', ')})` });
    }
  }

  for (const [concept, command] of Object.entries(forgeConfig)) {
    if (concept === 'provider') continue; // Already handled above
    if (command === null) {
      results.push({ concept, status: 'disabled', message: `Concept '${concept}' is explicitly disabled` });
    } else if (command === '') {
      results.push({ concept, status: 'empty_command', message: `Concept '${concept}' has an empty command string` });
    } else if (!(concept in getDefaultCommands())) {
      results.push({ concept, status: 'unknown_concept', message: `Concept '${concept}' is not a known forge concept` });
    } else {
      results.push({ concept, status: 'ok', message: `Concept '${concept}' overridden: ${command}` });
    }
  }

  return results;
}

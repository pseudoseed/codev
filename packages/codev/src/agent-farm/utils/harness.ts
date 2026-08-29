/**
 * Agent harness abstraction.
 *
 * Encapsulates how different agent CLI tools (Claude, Codex, etc.)
 * handle role/system prompt injection. Built-in providers cover Claude, Codex,
 * and OpenCode. Custom providers can be defined in .codev/config.json.
 *
 * The built-in Gemini CLI harness was retired in Issue #1338 (Google ended
 * consumer-tier Gemini CLI availability on 2026-06-18); selecting it now fails
 * closed with a retirement message instead of resolving a provider. See
 * RETIRED_HARNESSES below.
 *
 * Two integration patterns exist:
 * - Node spawn() call sites: use buildRoleInjection() → returns args + env
 * - Bash script generation: use buildScriptRoleInjection() → returns fragment + env
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md
 */

import { findLatestSessionId, verifySessionOwnership } from './claude-session-discovery.js';
import { buildWorktreeGuardFiles } from './worktree-write-guard.js';

// =============================================================================
// Types
// =============================================================================

/**
 * What byte safely ENDS A TURN on a given agent's TUI (Issue #196).
 *
 * Not a style choice — a correctness fact per app, on the same footing as the
 * model flag or the prompt arg. claude and codex read Ctrl+C as "interrupt the
 * turn"; **opencode reads it as "quit"** and the process exits. Verified in the
 * Tower log 2026-08-29: an unconditional `\x03` to an opencode builder took the
 * shellper down 30s later, and opencode has no conversation resume, so the
 * replacement woke with no memory of its work.
 *
 * ESC is the universal safe form — it ends the turn on all three (it is what
 * opencode itself advertises: its busy footer reads `esc interrupt`, the string
 * `OPENCODE_PROFILE.busyIndicatorPattern` matches). So callers DOWNGRADE to ESC
 * on an `esc` harness rather than refusing; the operator's intent still lands.
 */
export type InterruptSignal = 'esc' | 'ctrl-c';

/** The wire byte for each signal. The ONLY place these control bytes are spelled. */
export const INTERRUPT_BYTES: Record<InterruptSignal, string> = {
  esc: '\x1b',
  'ctrl-c': '\x03',
};

/**
 * What keystroke CLEARS leftover text from a given agent's composer (Issue #196).
 *
 * A different question from {@link InterruptSignal}, and deliberately a separate fact:
 * ending a turn and clearing a draft are different intents, and on opencode they need
 * different bytes. `'none'` means no byte is known to clear this app's composer without
 * risking something worse — the recovery then declines and says so, rather than writing
 * a guess.
 *
 * Read out of the shipped opencode 1.18.18 binary's default keybind table:
 *   app_exit:                   "ctrl+c,ctrl+d,<leader>q"
 *   input_clear:                "ctrl+c"
 *   input_delete_to_line_start: "ctrl+u"
 * Ctrl+C is bound to BOTH `app_exit` and `input_clear` — that overlap is the whole bug,
 * and it is in opencode's own config, not in ours. `ctrl+u` is bound to exactly one
 * action in the entire table, so it clears the line and can quit nothing.
 */
export type ClearDraftKey = 'ctrl-c' | 'ctrl-u' | 'none';

/**
 * The wire byte for each clear key. `'none'` has none, by construction.
 *
 * `'ctrl-c'` is DERIVED from {@link INTERRUPT_BYTES}, not re-spelled. The two tables
 * name the same physical key, and `promptReadySequence`'s dedup is a string compare —
 * so if these ever drifted apart, every claude and codex builder would silently get two
 * writes where it gets one today. Deriving makes that drift unrepresentable rather than
 * merely untested (CMAP round 1, finding 5).
 */
export const CLEAR_DRAFT_BYTES: Record<Exclude<ClearDraftKey, 'none'>, string> = {
  'ctrl-c': INTERRUPT_BYTES['ctrl-c'],
  'ctrl-u': '\x15',
};

export interface HarnessProvider {
  /**
   * The signal that safely interrupts a turn on this harness (Issue #196).
   *
   * REQUIRED, deliberately: a new built-in harness that forgets to declare it is
   * a compile error, not a silent default into `ctrl-c` — which is exactly how
   * this bug would come back. See {@link InterruptSignal}.
   */
  interruptSignal: InterruptSignal;

  /**
   * The keystroke that clears leftover text from this harness's composer (Issue #196),
   * or `'none'` when no byte is known to do it safely. See {@link ClearDraftKey}.
   *
   * REQUIRED for the same reason as {@link HarnessProvider.interruptSignal}: the #92
   * auto-recovery writes this byte with no operator in the loop, so an omitted entry
   * must be a compile error rather than a default.
   */
  clearDraftKey: ClearDraftKey;
  /**
   * For Node spawn() call sites (architect.ts, tower-utils.ts).
   * Returns CLI args and env vars to inject the role.
   */
  buildRoleInjection(roleContent: string, roleFilePath: string): {
    args: string[];
    env: Record<string, string>;
  };

  /**
   * For bash script generation (spawn-worktree.ts).
   * Returns a shell fragment to append after the base command,
   * and env vars the caller should export before the command.
   */
  buildScriptRoleInjection(roleContent: string, roleFilePath: string): {
    fragment: string;
    env: Record<string, string>;
  };

  /**
   * For bash script generation: how this agent's CLI takes the builder's INITIAL
   * PROMPT. Returns the fragment appended after the command and role injection.
   *
   * Omitted means the claude/codex convention — the prompt as a bare positional
   * argument — which is what every call site did unconditionally before Issue #4,
   * so an omitting harness generates a byte-identical script.
   *
   * opencode needs this because its positional slot is `[project]` ("path to start
   * opencode in"), not a message: passing the prompt there made it try to `cd` into
   * the prompt text, fail, and exit immediately — a builder that launched and never
   * ran. It takes the initial message via `--prompt` instead.
   *
   * `promptFileReadExpr` is the already-quoted shell expression that reads the prompt
   * file back (e.g. `"$(cat '/…/.builder-prompt.txt')"`), so implementations position
   * it rather than re-quoting it.
   */
  buildScriptPromptArg?(promptFileReadExpr: string): string;

  /**
   * For Node spawn() call sites: how this agent's CLI pins a MODEL.
   *
   * Optional, and absence is meaningful: it declares "this harness exposes no
   * model selector". `assertHarnessAcceptsModel` turns that into a loud error
   * rather than letting `--model` be silently dropped — the exact
   * registered-documented-inert failure `--model-id` shipped with once already
   * (see commands/consult/cli-options.ts, spec 1286).
   *
   * Follows the `buildScriptPromptArg` precedent from Issue #4: a small optional
   * method here beats special-casing a harness at the call site.
   */
  buildModelArgs?(modelId: string): string[];

  /**
   * For bash script generation: the shell fragment that pins the model.
   *
   * The dual-form counterpart of buildModelArgs, mirroring the
   * buildRoleInjection / buildScriptRoleInjection convention. Implementations
   * must shell-escape `modelId` themselves (via shellEscapeSingleQuote) — it is
   * a raw CLI value, not a pre-quoted expression like `promptFileReadExpr`.
   */
  buildScriptModelArg?(modelId: string): string;

  /**
   * Whether this harness can clear its conversation context in-session, without
   * restarting the process (Spec 1273 — `afx refresh`).
   *
   * Optional, and absence means "no": a harness that has not declared support
   * must not be reset, and defaulting to unsupported is the safe direction. Only
   * Claude declares it today (`/clear`), which is why `afx refresh` refuses other
   * harnesses loudly rather than improvising a substitute mechanism.
   */
  supportsContextReset?: boolean;

  /**
   * Optional: files to write in the worktree before launching the agent.
   * Used by harnesses that rely on file-based configuration (e.g., OpenCode
   * uses opencode.json's instructions field for role injection; Claude uses it
   * to install the worktree write-guard hook — Issue #1018).
   *
   * `worktreePath` is the absolute path to the builder's worktree, needed by
   * harnesses that bake worktree-specific values into generated files.
   */
  getWorktreeFiles?(roleContent: string, roleFilePath: string, worktreePath: string): Array<{
    relativePath: string;
    content: string;
  }>;

  /**
   * Optional: conversation-session support, for agents whose CLI can pin and
   * resume a session by id (Issue #832). Harnesses that omit this are treated as
   * having no resumable sessions — architects on those agents always spawn fresh
   * and nothing is persisted. Keeps agent-specific session flags out of Tower.
   *
   * This is the stored-UUID mechanism (architect resume): an id is minted at spawn,
   * pinned via `newSessionArgs`, persisted on the architect row, and replayed via
   * `resumeArgs`. It disambiguates siblings sharing one cwd, which `buildResume`
   * (mtime discovery) cannot. The two coexist: `buildResume` serves builder resume
   * and the legacy sole-architect fallback; `session` serves architect stored-UUID resume.
   */
  session?: {
    /** Args to START a new session pinned to `sessionId` (caller merges role injection). */
    newSessionArgs(sessionId: string): string[];
    /** Args to RESUME an existing session by id (caller skips role injection). */
    resumeArgs(sessionId: string): string[];
    /**
     * Optional: script-fragment forms of newSessionArgs/resumeArgs for bash
     * script generation (the builder launch loop — Issue #1233), mirroring the
     * dual-form convention of buildRoleInjection/buildScriptRoleInjection and
     * buildResume's args/scriptFragment pair.
     *
     * `idExpr` is a shell expression the caller has already quoted (e.g.
     * `"$codev_session_id"`), NOT a literal id: the generated loop re-mints ids
     * at runtime (clean-exit relaunch, unresumable-session degrade), so the
     * fragment must reference the script's variable rather than bake a value.
     *
     * BOTH must be present for the session-aware loop; a harness providing
     * neither keeps the historical prompt-replay restart loop.
     */
    newSessionScriptFragment?(idExpr: string): string;
    resumeScriptFragment?(idExpr: string): string;
    /**
     * Optional: verify that `sessionId` still has a resumable session on disk
     * for `cwd` before the caller resumes it (Issue #1145). Returns false when
     * the session file is gone (a stored id can outlive its jsonl); callers
     * then spawn fresh instead of baking a broken resume into a restart loop.
     * Harnesses that omit this are trusted as-is.
     */
    verifyOwnership?(sessionId: string, cwd: string, opts?: { homeDir?: string }): boolean;
  };

  /**
   * Optional: discover a resumable prior session for the given working dir and
   * return how to resume it — in BOTH forms, mirroring buildRoleInjection /
   * buildScriptRoleInjection:
   *   - args:           Node argv for spawn() call sites (architect launch)
   *   - scriptFragment: shell-escaped fragment for bash script generation (builder)
   * Returns null when no resumable session exists or this harness has no
   * cwd-keyed session store → callers fall back to a fresh launch. Only Claude
   * implements it (store: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl).
   *
   * Discovery-based (newest jsonl by mtime): used for builder resume
   * (#831/#929) ONLY. Architect launch never discovers — it resumes solely from
   * the stored session id on the workspace-scoped architect row, else spawns
   * fresh (Issue #1145: discovery on a fresh workspace hijacked whatever Claude
   * conversation the user last held in that directory).
   */
  buildResume?(absolutePath: string, opts?: { homeDir?: string }): {
    sessionId: string;
    args: string[];
    scriptFragment: string;
  } | null;
}

/** Custom harness definition from .codev/config.json */
export interface CustomHarnessConfig {
  roleArgs: string[];
  roleEnv?: Record<string, string>;
  roleScriptFragment: string;
  roleScriptEnv?: Record<string, string>;
  /**
   * Optional model selection, expanding `${MODEL}` (Issue #2). Both are optional
   * and omitting them declares "no model selector", so every config written
   * before this existed keeps validating and behaving identically.
   */
  modelArgs?: string[];
  modelScriptFragment?: string;
  /**
   * Optional binary/command that runs this harness, for a per-spawn
   * `--harness <name>` (Issue #2). Without it a per-spawn selection falls back
   * to the workspace's configured builder command (when that command already is
   * this harness) and then to the bare name — see resolveHarnessCommand.
   */
  command?: string;
}

// =============================================================================
// Built-in providers
// =============================================================================

export const CLAUDE_HARNESS: HarnessProvider = {
  // Verified: Claude Code reads Ctrl+C as "end this turn" and keeps the process,
  // and the same byte clears a leftover composer line.
  interruptSignal: 'ctrl-c',
  clearDraftKey: 'ctrl-c',
  // Spec 1273: `/clear` empties the conversation while leaving the process — and
  // therefore the --append-system-prompt role below — intact. That is what makes
  // an in-session reset possible here and nowhere else today.
  supportsContextReset: true,
  buildRoleInjection: (content, _filePath) => ({
    args: ['--append-system-prompt', content],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `--append-system-prompt "$(cat '${shellEscapeSingleQuote(filePath)}')"`,
    env: {},
  }),
  // Issue #2. Verified against the installed CLI: `--model <model>` takes an alias
  // ('opus', 'sonnet') or a full id ('claude-fable-5').
  buildModelArgs: (modelId) => ['--model', modelId],
  buildScriptModelArg: (modelId) => `--model '${shellEscapeSingleQuote(modelId)}'`,
  buildResume: (absolutePath, opts) => {
    const sessionId = findLatestSessionId(absolutePath, opts);
    if (!sessionId) return null;
    return {
      sessionId,
      args: ['--resume', sessionId],
      scriptFragment: `--resume '${shellEscapeSingleQuote(sessionId)}'`,
    };
  },
  // Install the worktree write-guard PreToolUse hook (Issue #1018) so a builder
  // cannot silently write outside its worktree (e.g. into the main checkout).
  getWorktreeFiles: (_content, _filePath, worktreePath) =>
    buildWorktreeGuardFiles(worktreePath),
  // Issue #832: Claude pins/resumes a conversation by UUID and stores each session
  // as ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  session: {
    newSessionArgs: (sessionId) => ['--session-id', sessionId],
    resumeArgs: (sessionId) => ['--resume', sessionId],
    // Issue #1233: script-fragment forms for the builder crash-resume loop.
    // `idExpr` arrives pre-quoted (a shell variable reference, not a literal).
    newSessionScriptFragment: (idExpr) => `--session-id ${idExpr}`,
    resumeScriptFragment: (idExpr) => `--resume ${idExpr}`,
    // Issue #1145: a stored id is only resumed when its jsonl still exists
    // under this cwd's project dir (stale ids degrade to a fresh spawn).
    verifyOwnership: (sessionId, cwd, opts) => verifySessionOwnership(cwd, sessionId, opts),
  },
};

export const CODEX_HARNESS: HarnessProvider = {
  // Verified: codex-cli reads Ctrl+C as "end this turn" and keeps the process,
  // and the same byte clears a leftover composer line.
  interruptSignal: 'ctrl-c',
  clearDraftKey: 'ctrl-c',
  buildRoleInjection: (_content, filePath) => ({
    args: ['-c', `model_instructions_file=${filePath}`],
    env: {},
  }),
  buildScriptRoleInjection: (_content, filePath) => ({
    fragment: `-c model_instructions_file='${shellEscapeSingleQuote(filePath)}'`,
    env: {},
  }),
  // Issue #2. Verified against codex-cli 0.148.0: `-m, --model <MODEL>`. Spelled
  // out as `--model` rather than `-m` so a generated launch script stays readable.
  buildModelArgs: (modelId) => ['--model', modelId],
  buildScriptModelArg: (modelId) => `--model '${shellEscapeSingleQuote(modelId)}'`,
};

export const OPENCODE_HARNESS: HarnessProvider = {
  // Issue #196, both read out of opencode 1.18.18's default keybind table:
  //   session_interrupt: "escape"     -> ends the turn (its busy footer says so too)
  //   app_exit:          "ctrl+c,..."  } Ctrl+C is BOTH, which is why it can quit
  //   input_clear:       "ctrl+c"     }
  //   input_delete_to_line_start: "ctrl+u"  -> the only ctrl+u binding in the table
  interruptSignal: 'esc',
  clearDraftKey: 'ctrl-u',
  buildRoleInjection: () => {
    throw new Error(
      'OpenCode is only supported as a builder shell, not as an architect shell. ' +
      'OpenCode uses file-based role injection (opencode.json instructions field) ' +
      'which requires an ephemeral worktree. Configure a different shell for ' +
      'the architect (e.g., "claude --dangerously-skip-permissions").',
    );
  },
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),
  // Issue #4: `opencode [project]` treats its positional as a directory to start in,
  // so the generic positional prompt made the TUI exit at once ("Failed to change
  // directory to <cwd>/<the entire prompt text>"). `--prompt` seeds the initial message
  // into a TUI that stays running, which `opencode run` — the other candidate, and what
  // the docs previously recommended — does not: that form answers once and exits, so the
  // builder would die after a single turn. Verified against opencode 1.18.18.
  buildScriptPromptArg: (promptFileReadExpr) => `--prompt ${promptFileReadExpr}`,
  // Issue #2. Verified against opencode 1.18.18: `-m, --model`, taking the value in
  // `provider/model` form (e.g. `x-ai/grok-4.6`). MODEL_ID_RE already permits "/",
  // so that form validates without loosening the shared pattern.
  buildModelArgs: (modelId) => ['--model', modelId],
  buildScriptModelArg: (modelId) => `--model '${shellEscapeSingleQuote(modelId)}'`,
  getWorktreeFiles: () => ([{
    relativePath: 'opencode.json',
    content: JSON.stringify({ instructions: ['.builder-role.md'] }, null, 2) + '\n',
  }]),
};

/**
 * Exported for Spec 1273: `afx refresh` identifies a running builder's harness from
 * its launch script and must check `supportsContextReset` before typing into the
 * terminal. It needs the name→provider map, not just the workspace default.
 */
export const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  opencode: OPENCODE_HARNESS,
};

/**
 * The built-in provider for `name`, or `undefined` when `name` is not a built-in
 * harness. Uses an own-property check — the same guard `isRetiredHarness` gives
 * `RETIRED_HARNESSES` — so inherited Object members (`constructor`, `toString`,
 * `hasOwnProperty`, `valueOf`, …) on a *user-controlled* name are never misread as
 * a provider. A bare `BUILTIN_HARNESSES[name]` for `name = 'constructor'` returns
 * `Object`'s constructor (a truthy function), which a `if (builtin) return builtin`
 * check would then hand back as a bogus "provider" that TypeErrors at the first
 * `buildRoleInjection` call. The name reaches here straight from config
 * (`shell.builderHarness` / a builder launch script), so the key is untrusted.
 */
export function getBuiltinHarness(name: string): HarnessProvider | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_HARNESSES, name)
    ? BUILTIN_HARNESSES[name]
    : undefined;
}

// =============================================================================
// Retired harnesses
// =============================================================================

/**
 * Built-in harness names Codev no longer supports, each mapped to the
 * explanation shown when a user still selects it.
 *
 * A retired name is intercepted on *every* `resolveHarness` exit — the explicit
 * path and the command auto-detect path — so it fails loudly and closed rather
 * than silently falling back to Claude (the Issue #929 mis-injection class) or
 * returning `undefined` (a `BUILTIN_HARNESSES[name]` miss → downstream
 * TypeError). See `resolveHarness` and Issue #1338.
 *
 * Escape hatch: a user who retains access to a retired CLI (e.g. an
 * enterprise/API-key Gemini subscription) can still wire it as a *custom*
 * harness in .codev/config.json — the retirement targets the built-in name,
 * not a user's own definition.
 */
export const RETIRED_HARNESSES: Record<string, string> = {
  gemini:
    'The built-in Gemini CLI harness is retired. Google ended Gemini CLI ' +
    'availability for consumer accounts (free, Pro, and Ultra tiers) on ' +
    '2026-06-18, so it no longer works for most users. Use a supported harness ' +
    'instead: claude, codex, or opencode. If you still have Gemini CLI access ' +
    '(a Standard/Enterprise subscription or API-key auth), define a custom ' +
    'harness named "gemini" in .codev/config.json under the "harness" section ' +
    'and select it explicitly with shell.builderHarness / shell.architectHarness ' +
    '— a bare auto-detected "gemini" command stays retired. See issue #1338.',
};

/**
 * Whether `name` is a retired built-in harness. Uses an own-property check so
 * inherited Object keys (`constructor`, `toString`, …) are never misread as
 * retired.
 */
export function isRetiredHarness(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_HARNESSES, name);
}

/**
 * The retirement explanation for `name`, or `undefined` when `name` is not a
 * retired harness.
 */
export function getRetirement(name: string): string | undefined {
  return isRetiredHarness(name) ? RETIRED_HARNESSES[name] : undefined;
}

/**
 * Error thrown when a retired harness name is selected. A distinct type lets a
 * caller scope a `catch` to the retirement — return a safe default, or abort a
 * spawn before it creates state — and rethrow every other error unchanged. Used
 * by the spawn pre-flight and the Tower-side `siblingRegistrationIsLive`
 * predicate (Issue #1338). `harnessName` is the retired name that triggered it.
 */
export class RetiredHarnessError extends Error {
  constructor(public readonly harnessName: string, message: string) {
    super(message);
    this.name = 'RetiredHarnessError';
  }
}

/**
 * Throw the consistent retirement error for retired harness `name`. Returns
 * `never` so callers can use it as a resolver exit on any branch and keep one
 * identical message regardless of which path selected the retired name.
 */
export function throwRetired(name: string): never {
  throw new RetiredHarnessError(name, getRetirement(name) ?? `The "${name}" harness is retired.`);
}

// =============================================================================
// Template expansion
// =============================================================================

/**
 * Expand template variables in a string.
 * ${ROLE_FILE} → roleFilePath, ${ROLE_CONTENT} → roleContent.
 * Unknown ${...} variables are left unexpanded (makes typos visible).
 */
function expandTemplateVars(template: string, roleContent: string, roleFilePath: string): string {
  // Use replacer functions to avoid $& / $' / $` interpretation in replacement strings
  return template
    .replace(/\$\{ROLE_FILE\}/g, () => roleFilePath)
    .replace(/\$\{ROLE_CONTENT\}/g, () => roleContent);
}

/**
 * Expand `${MODEL}` in a custom harness's model template (Issue #2).
 *
 * Kept separate from `expandTemplateVars` rather than folded into it: the role
 * templates are expanded at a call site that has no model in hand, so a shared
 * signature would force a meaningless placeholder through every role expansion.
 * Unknown `${...}` variables are left unexpanded here too, so a typo stays visible.
 */
function expandModelVar(template: string, modelId: string): string {
  return template.replace(/\$\{MODEL\}/g, () => modelId);
}

/**
 * Escape a string for safe inclusion inside single quotes in bash.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// =============================================================================
// Custom harness provider
// =============================================================================

/**
 * Build a HarnessProvider from a custom config definition.
 * Template variables (${ROLE_FILE}, ${ROLE_CONTENT}) are expanded at call time.
 */
export function buildCustomHarnessProvider(config: CustomHarnessConfig): HarnessProvider {
  // Attached only when configured, so an unconfigured custom harness keeps the
  // meaningful `undefined` that `assertHarnessAcceptsModel` reads as "no model
  // selector" — rather than silently accepting `--model` and dropping it.
  const modelHooks: Pick<HarnessProvider, 'buildModelArgs' | 'buildScriptModelArg'> = {};
  if (config.modelArgs) {
    const modelArgs = config.modelArgs;
    modelHooks.buildModelArgs = (modelId) => modelArgs.map(arg => expandModelVar(arg, modelId));
  }
  if (config.modelScriptFragment !== undefined) {
    const fragment = config.modelScriptFragment;
    modelHooks.buildScriptModelArg = (modelId) => expandModelVar(fragment, modelId);
  }

  return {
    ...modelHooks,
    // Issue #196: a custom harness is never resolved by the interrupt path today —
    // `detectHarnessFromCommand` matches only built-in basenames, and neither
    // `resolveHarnessForSession` nor `promptReadySequence` threads `customHarnesses`
    // through. So these are the fail-safe constants, NOT configurable: a declared-but-
    // unreachable config field is the "registered, documented, inert" shape
    // `assertHarnessAcceptsModel` below exists to prevent. Wire the resolvers to custom
    // harnesses first, then make these configurable in the same change.
    interruptSignal: 'esc',
    clearDraftKey: 'none',
    buildRoleInjection: (content, filePath) => ({
      args: config.roleArgs.map(arg => expandTemplateVars(arg, content, filePath)),
      env: Object.fromEntries(
        Object.entries(config.roleEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
    buildScriptRoleInjection: (content, filePath) => ({
      fragment: expandTemplateVars(config.roleScriptFragment, content, filePath),
      env: Object.fromEntries(
        Object.entries(config.roleScriptEnv ?? {}).map(
          ([k, v]) => [k, expandTemplateVars(v, content, filePath)],
        ),
      ),
    }),
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a custom harness config entry.
 * Throws a descriptive error if required fields are missing or wrong type.
 */
export function validateCustomHarnessConfig(name: string, config: unknown): CustomHarnessConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(`Harness "${name}": expected an object, got ${typeof config}`);
  }

  const obj = config as Record<string, unknown>;

  if (!Array.isArray(obj.roleArgs)) {
    throw new Error(`Harness "${name}": missing required field "roleArgs" (must be a string array)`);
  }
  if (!obj.roleArgs.every((a: unknown) => typeof a === 'string')) {
    throw new Error(`Harness "${name}": "roleArgs" must contain only strings`);
  }

  if (typeof obj.roleScriptFragment !== 'string') {
    throw new Error(`Harness "${name}": missing required field "roleScriptFragment" (must be a string)`);
  }

  if (obj.roleEnv !== undefined) {
    if (typeof obj.roleEnv !== 'object' || obj.roleEnv === null) {
      throw new Error(`Harness "${name}": "roleEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  if (obj.roleScriptEnv !== undefined) {
    if (typeof obj.roleScriptEnv !== 'object' || obj.roleScriptEnv === null) {
      throw new Error(`Harness "${name}": "roleScriptEnv" must be an object if provided`);
    }
    for (const [k, v] of Object.entries(obj.roleScriptEnv as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Harness "${name}": "roleScriptEnv.${k}" must be a string, got ${typeof v}`);
      }
    }
  }

  if (obj.modelArgs !== undefined) {
    if (!Array.isArray(obj.modelArgs)) {
      throw new Error(`Harness "${name}": "modelArgs" must be a string array if provided`);
    }
    if (!obj.modelArgs.every((a: unknown) => typeof a === 'string')) {
      throw new Error(`Harness "${name}": "modelArgs" must contain only strings`);
    }
  }

  if (obj.command !== undefined && typeof obj.command !== 'string') {
    throw new Error(`Harness "${name}": "command" must be a string, got ${typeof obj.command}`);
  }

  if (obj.modelScriptFragment !== undefined && typeof obj.modelScriptFragment !== 'string') {
    throw new Error(
      `Harness "${name}": "modelScriptFragment" must be a string, got ${typeof obj.modelScriptFragment}`,
    );
  }

  return obj as unknown as CustomHarnessConfig;
}

// =============================================================================
// Model support
// =============================================================================

/**
 * Error thrown when a model is requested for a harness that has no model selector.
 *
 * A distinct type so a caller can scope a `catch` to this case, matching the
 * `RetiredHarnessError` precedent. `harnessName` is the harness that cannot
 * honour the model.
 */
export class ModelUnsupportedError extends Error {
  constructor(public readonly harnessName: string, message: string) {
    super(message);
    this.name = 'ModelUnsupportedError';
  }
}

/**
 * Reject a model selection for a harness that cannot honour it (Issue #2).
 *
 * Modelled on `assertLaneAcceptsModelOverride` in lib/consult-lanes.ts, and here
 * for the same reason spec 1286 needed it there: without this, `--model` against
 * a selector-less harness parses, appears in `--help`, and does exactly nothing.
 * That "registered, documented, inert" outcome is the failure `--model-id` shipped
 * with once already. A flag that cannot take effect must say so.
 *
 * `acceptingNames` is the set of harness names that DO accept a model, so the
 * message can name the alternatives rather than just refusing. The caller supplies
 * it because only the caller knows the custom harnesses: resolving them here via
 * `getBuiltinHarness` silently dropped every model-capable CUSTOM harness from the
 * message, telling a user their only options were built-ins when their own config
 * offered another.
 */
export function assertHarnessAcceptsModel(
  harnessName: string,
  provider: HarnessProvider,
  acceptingNames: readonly string[] = Object.keys(BUILTIN_HARNESSES).filter(
    (n) => getBuiltinHarness(n)?.buildScriptModelArg !== undefined,
  ),
  flag = '--model',
): void {
  if (provider.buildScriptModelArg && provider.buildModelArgs) return;

  const accepting = acceptingNames;

  throw new ModelUnsupportedError(
    harnessName,
    `${flag} is not supported for the "${harnessName}" harness — it exposes no model selector.\n` +
    `Harnesses that accept a model: ${accepting.join(', ') || '(none)'}.\n` +
    `A custom harness can declare one by setting "modelArgs" and "modelScriptFragment" ` +
    `(both expanding \${MODEL}) in .codev/config.json under the "harness" section.`,
  );
}

// =============================================================================
// Interrupt signal resolution
// =============================================================================

/**
 * The interrupt signal for a harness NAME, fail-safe (Issue #196).
 *
 * The single table every interrupt caller reads. Resolution is deliberately
 * narrower than {@link resolveHarness}: an unknown, retired or CUSTOM name yields
 * `esc` rather than falling through to CLAUDE_HARNESS's `ctrl-c`. That default is
 * the whole point — `resolveHarness`'s claude fallback is what would hand an
 * unidentified opencode terminal the byte that kills it.
 *
 * Built-ins only, and no `customHarnesses` parameter: nothing on the interrupt path can
 * resolve a custom harness today (`detectHarnessFromCommand` matches built-in basenames
 * only), so accepting one would be an inert parameter dressed as support. A plain SHELL
 * is handled by the caller via {@link SHELL_TARGET} — it is a known target, not an
 * unknown harness.
 */
export function interruptSignalForHarness(harnessName: string | undefined | null): InterruptSignal {
  if (!harnessName) return 'esc';
  return getBuiltinHarness(harnessName)?.interruptSignal ?? 'esc';
}

/**
 * The human name of a control byte, for logs and API responses (Issue #196).
 *
 * Operators reason in keystrokes, not escapes, and the whole complaint behind this issue
 * was that nothing told them which byte went out. Unknown bytes are rendered as their hex
 * escape rather than guessed at.
 */
export function keyName(byte: string): string {
  if (byte === INTERRUPT_BYTES.esc) return 'ESC';
  if (byte === CLEAR_DRAFT_BYTES['ctrl-c']) return 'Ctrl+C';
  if (byte === CLEAR_DRAFT_BYTES['ctrl-u']) return 'Ctrl+U';
  return `\\x${byte.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

/** Render a byte sequence as a readable keystroke list, e.g. `ESC then Ctrl+U`. */
export function describeInterruptBytes(bytes: readonly string[]): string {
  return bytes.length ? bytes.map(keyName).join(' then ') : 'nothing';
}

/**
 * The keystroke that clears a leftover draft on `harnessName`, fail-safe (Issue #196).
 *
 * Unknown, retired and custom harnesses resolve to `'none'`: no byte is written at all,
 * and the caller reports the hold as unrecoverable rather than guessing. Built-ins only,
 * for the same reason as {@link interruptSignalForHarness}.
 */
export function clearDraftKeyForHarness(harnessName: string | undefined | null): ClearDraftKey {
  if (!harnessName) return 'none';
  return getBuiltinHarness(harnessName)?.clearDraftKey ?? 'none';
}

// =============================================================================
// Auto-detection
// =============================================================================

/**
 * POSIX shells, whose interrupt is a KNOWN fact rather than an unknown one (Issue #196,
 * CMAP round 1 finding 1).
 *
 * `afx send <shell-id> --interrupt` is reachable — `resolveAgentInRegistry` matches
 * `entry.shells` — and a plain shell has no harness and no `.builder-start.sh`, so it was
 * resolving into the unknown bucket and receiving a lone ESC. **bash ignores ESC.** That
 * turned Spec 0020's original purpose for the flag, escaping a running process (the "Vim
 * trap"), into a silent no-op that still reported success.
 *
 * Ctrl+C is right for a shell in BOTH halves of the contract: SIGINT to the foreground
 * job, and readline discards the current input line. Fail-safe was the correct instinct
 * for a genuinely unidentifiable target; a shell is identifiable, so it is identified.
 */
const SHELL_BASENAMES = ['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'];

/** The keystroke facts for a plain shell target. */
export const SHELL_TARGET: { interruptSignal: InterruptSignal; clearDraftKey: ClearDraftKey } = {
  interruptSignal: 'ctrl-c',
  clearDraftKey: 'ctrl-c',
};

/**
 * Whether `command` launches a plain POSIX shell.
 *
 * Deliberately an EXACT basename match, not a substring one: `detectHarnessFromCommand`
 * uses `includes` and can afford to, but a loose match here would claim things like
 * `shellper` or a wrapper script ending in `-sh`, and claiming a target wrongly is how a
 * fatal byte gets sent. Callers must consult this only AFTER harness detection and the
 * `.builder-start.sh` lookup have both failed — a builder's own `session.command` is the
 * shell that wraps its agent, and matching that first would send Ctrl+C to an opencode
 * builder, which is the original bug.
 */
export function isShellCommand(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return false;
  const basename = (firstToken.split('/').pop() || firstToken).toLowerCase();
  return SHELL_BASENAMES.includes(basename);
}

/**
 * Detect harness type from a command string by extracting the basename of the
 * first token and matching against known CLI names.
 * Returns undefined if no match (caller decides what to do).
 */
export function detectHarnessFromCommand(command: string): string | undefined {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return undefined;

  // Extract basename (handles full paths like /opt/homebrew/bin/codex)
  const basename = firstToken.split('/').pop() || firstToken;

  if (basename.includes('claude')) return 'claude';
  if (basename.includes('codex')) return 'codex';
  if (basename.includes('gemini')) return 'gemini';
  if (basename.includes('opencode')) return 'opencode';

  return undefined;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a harness name to a HarnessProvider.
 *
 * Resolution order:
 * 1. Explicit harnessName → built-in provider, else custom provider
 * 2. Retired name → throw the retirement error (fail closed). A same-named
 *    custom harness still wins for an *explicit* name (the escape hatch), but an
 *    auto-detected retired command is always retired — auto-detection never
 *    consults custom harnesses (Issue #1338).
 * 3. Auto-detect from command string basename (if command provided)
 * 4. Default to claude (backward compatible)
 *
 * Throws if harnessName is retired, or is set but doesn't match any provider.
 */
export function resolveHarness(
  harnessName: string | undefined,
  customHarnesses?: Record<string, CustomHarnessConfig>,
  command?: string,
): HarnessProvider {
  // Explicit harness name takes priority
  if (harnessName) {
    // Own-property lookup: `harnessName` is user-controlled, so a bare index could
    // return an inherited Object member (`constructor`, …) as a bogus provider.
    const builtin = getBuiltinHarness(harnessName);
    if (builtin) return builtin;

    if (customHarnesses && harnessName in customHarnesses) {
      return buildCustomHarnessProvider(customHarnesses[harnessName]);
    }

    // A retired name with no custom override fails closed with a clear message.
    // Checked after the custom lookup so an explicit custom `gemini` (the
    // escape hatch for retained enterprise/API-key access) still resolves.
    if (isRetiredHarness(harnessName)) throwRetired(harnessName);

    const knownNames = Object.keys(BUILTIN_HARNESSES);
    const customNames = customHarnesses ? Object.keys(customHarnesses) : [];
    const allNames = [...knownNames, ...customNames];

    throw new Error(
      `Unknown harness "${harnessName}". ` +
      `Available harnesses: ${allNames.join(', ') || '(none)'}. ` +
      `Configure a custom harness in .codev/config.json under the "harness" section.`,
    );
  }

  // Auto-detect from command basename
  if (command) {
    const detected = detectHarnessFromCommand(command);
    if (detected) {
      // Intercept a retired detected name BEFORE the BUILTIN_HARNESSES lookup:
      // it must never return undefined (removed registry entry) nor fall through
      // to the Claude default below (the #929 silent-mismatch class). Auto-detect
      // resolves the built-in namespace only, so a detected `gemini` is retired
      // even when a custom `gemini` exists.
      if (isRetiredHarness(detected)) throwRetired(detected);
      return BUILTIN_HARNESSES[detected];
    }
  }

  // Default to claude
  return CLAUDE_HARNESS;
}

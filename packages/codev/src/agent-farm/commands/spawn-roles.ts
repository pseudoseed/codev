/**
 * Role and prompt template utilities for spawn command.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Handles template rendering, prompt building, and role loading
 * for builder sessions.
 */

import { resolve, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { SpawnOptions, Config, ProtocolDefinition } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadRolePrompt } from '../utils/roles.js';
import { stripLeadingZeros } from '../utils/agent-names.js';
import { resolveCodevFile, getSkeletonDir, resolveCodevIncludes } from '../../lib/skeleton.js';

// =============================================================================
// Template Rendering
// =============================================================================

/**
 * Context object for rendering builder-prompt.md templates
 */
export interface TemplateContext {
  protocol_name: string;
  mode: 'strict' | 'soft';
  mode_soft: boolean;
  mode_strict: boolean;
  project_id?: string;
  input_description: string;
  spec?: {
    path: string;
    name: string;
  };
  plan?: {
    path: string;
    name: string;
  };
  issue?: {
    number: number | string;
    title: string;
    body: string;
  };
  task_text?: string;
  spec_missing?: boolean;
  existing_branch?: string;  // Spec 609: when --branch is used, the name of the existing branch
  protocol_reference?: string;  // #1011: protocol.md text, resolved fresh at spawn and inlined via the {{protocol_reference}} placeholder
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: TemplateContext, path: string): unknown {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Simple Handlebars-like template renderer
 * Supports: {{variable}}, {{#if condition}}...{{/if}}, {{object.property}}
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  let result = template;

  // Process {{#if condition}}...{{/if}} blocks
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ifMatch = result.match(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/);
    if (!ifMatch) break;

    const [fullMatch, condition, content] = ifMatch;
    const value = getNestedValue(context, condition);
    result = result.replace(fullMatch, value ? content : '');
  }

  // Process {{variable}} and {{object.property}} substitutions
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const value = getNestedValue(context, path);
    if (value === undefined || value === null) return '';
    return String(value);
  });

  // Clean up any double newlines left from removed sections
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Load builder-prompt.md template for a protocol.
 * Resolves through .codev/ → codev/ → cache → skeleton (via resolveCodevFile).
 */
function loadBuilderPromptTemplate(config: Config, protocolName: string): string | null {
  const templatePath = resolveCodevFile(
    `protocols/${protocolName}/builder-prompt.md`,
    config.workspaceRoot,
  );
  if (!templatePath) {
    return null;
  }
  // Builder prompts are also a delivery root: promptless handoffs such as
  // verify-approval need resolver-owned shared guidance at spawn time.
  return resolveCodevIncludes(readFileSync(templatePath, 'utf-8'), config.workspaceRoot);
}

/**
 * Compute the protocol meta-doc text to inline into the spawn prompt via the
 * `{{protocol_reference}}` placeholder. Reads `protocol.md` fresh through the
 * resolver (tier 4 reaches the embedded skeleton in fresh installs) and resolves
 * any `{{> ...}}` template includes inside it (via the shared resolver helper).
 * Returns '' when the protocol ships no `protocol.md`.
 */
function resolveProtocolReference(config: Config, protocolName: string): string {
  const protocolDocPath = resolveCodevFile(
    `protocols/${protocolName}/protocol.md`,
    config.workspaceRoot,
  );
  if (!protocolDocPath) {
    logger.debug(`No protocol.md for ${protocolName}; spawning without inlined reference`);
    return '';
  }
  return resolveCodevIncludes(readFileSync(protocolDocPath, 'utf-8'), config.workspaceRoot);
}

/**
 * Build the spawn prompt from the protocol's builder-prompt.md template.
 * Fails fast if the protocol ships no builder-prompt.md (no silent fallback):
 * a synthesized fallback would have to point the builder at codev/protocols/...
 * by literal path, which bypasses the four-tier resolver and breaks fresh
 * installs — the bug class this work exists to fix (#1011).
 */
export function buildPromptFromTemplate(
  config: Config,
  protocolName: string,
  context: TemplateContext
): string {
  const template = loadBuilderPromptTemplate(config, protocolName);
  if (!template) {
    // validateProtocol already fails fast on a missing builder-prompt.md at spawn;
    // this is the defensive backstop for any path that reaches here without it.
    fatal(
      `Protocol "${protocolName}" has no builder-prompt.md; cannot build a spawn prompt. ` +
      `Add protocols/${protocolName}/builder-prompt.md.`,
    );
  }
  logger.info(`Using template: protocols/${protocolName}/builder-prompt.md`);
  // Deliver the protocol meta-doc (and any templates it includes) fresh at
  // spawn via the {{protocol_reference}} placeholder, never a committed copy.
  const protocol_reference = resolveProtocolReference(config, protocolName);
  return renderTemplate(template, { ...context, protocol_reference });
}

// =============================================================================
// Resume Context
// =============================================================================

/**
 * Build a resume notice to prepend to the builder prompt.
 * Tells the builder this is a resumed session and to check existing porch state.
 */
export function buildResumeNotice(_projectId: string): string {
  return `## RESUME SESSION

This is a **resumed** builder session. A previous session was working in this worktree.

Start by running \`porch next\` to check your current state and get next tasks.
If porch state exists, continue from where the previous session left off.
If porch reports "not found", run \`porch init\` to re-initialize.
`;
}

// =============================================================================
// Role Loading
// =============================================================================

/**
 * Load a protocol-specific role if it exists.
 * Resolves through .codev/ → codev/ → cache → skeleton (via resolveCodevFile).
 */
export function loadProtocolRole(config: Config, protocolName: string): { content: string; source: string } | null {
  const protocolRolePath = resolveCodevFile(
    `protocols/${protocolName}/role.md`,
    config.workspaceRoot,
  );
  if (protocolRolePath) {
    return { content: readFileSync(protocolRolePath, 'utf-8'), source: 'protocol' };
  }
  // Fall back to builder role
  return loadRolePrompt(config, 'builder');
}

// =============================================================================
// Protocol Resolution
// =============================================================================

/** What a spec lookup found, and how sure it is (#65). */
export interface SpecLookup {
  /** The spec belonging to this id, or null when none does. */
  path: string | null;
  /**
   * A spec whose id matches only after stripping leading zeros.
   *
   * NOT returned as `path`. It is reported so the caller can explain why a spec
   * file that looks related is not being used.
   */
  nearMiss: string | null;
}

/**
 * Find the spec file belonging to `projectId`, by EXACT id.
 *
 * ## Why the zero-stripped fallback is gone (#65)
 *
 * It existed so `afx spawn 76` would find a legacy `0076-feature.md`. In a tree
 * that uses one numbering convention that is a convenience. In this one it
 * hands builders the wrong assignment, because the fork restarted issue
 * numbering at 1 against a tree carrying legacy artifacts numbered into the
 * 1400s — 116 of 175 specs are zero-padded, so most new issue numbers have a
 * twin that has nothing to do with them.
 *
 * Measured on 2026-08-23: three spawns hit it in one day.
 *
 *   afx spawn 38  -> 0038-consult-pr-mode.md (a 2025 TICK)   builder noticed
 *   afx spawn 39  -> 0039-codev-cli.md (shipped)             builder noticed
 *   afx spawn 63  -> 0063-tower-dashboard-improvements.md    builder did NOT
 *
 * The third cost about an hour and produced a competent, well-argued finding
 * about the wrong subject — which is harder to catch in review than an obvious
 * error. Two of three caught it, and that is luck, not a safety property.
 *
 * Warning instead of refusing was considered and rejected: with a twin for most
 * low issue numbers the warning would fire on nearly every spawn, and a warning
 * that always fires is trained past within a week.
 *
 * Exactness costs nothing, because the two forms already express different
 * intent: `afx spawn 63` asks for issue 63's spec, `afx spawn 0063` asks for
 * the legacy one, and each now finds exactly what it named. And "this issue has
 * no spec yet" is the NORMAL state at spawn — most protocols create the spec in
 * their first phase, and `spec_missing` is already a supported template flag.
 * An absent spec is a fact worth stating; a wrong one is not.
 */
export async function findSpecLookup(codevDir: string, projectId: string): Promise<SpecLookup> {
  const specsDir = resolve(codevDir, 'specs');

  if (!existsSync(specsDir)) {
    return { path: null, nearMiss: null };
  }

  const files = await readdir(specsDir);

  for (const file of files) {
    if (file.startsWith(projectId + '-') && file.endsWith('.md')) {
      return { path: resolve(specsDir, file), nearMiss: null };
    }
  }

  // Report the twin rather than using it, so "no spec" does not look like the
  // lookup failed to see a file that is plainly sitting there.
  const strippedId = stripLeadingZeros(projectId);
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePrefix = file.split('-')[0];
    if (stripLeadingZeros(filePrefix) === strippedId) {
      return { path: null, nearMiss: resolve(specsDir, file) };
    }
  }

  return { path: null, nearMiss: null };
}

/**
 * Back-compat wrapper: the spec belonging to `projectId`, or null.
 *
 * Never returns a zero-stripped near-miss. See {@link findSpecLookup}.
 */
export async function findSpecFile(codevDir: string, projectId: string): Promise<string | null> {
  return (await findSpecLookup(codevDir, projectId)).path;
}

/**
 * List all protocol directory names visible across the resolver tiers
 * (.codev/protocols, codev/protocols, embedded skeleton). Used to surface
 * available alternatives when a requested protocol is not found.
 */
function listAvailableProtocols(config: Config): string[] {
  const seen = new Set<string>();
  const candidates = [
    resolve(config.workspaceRoot, '.codev', 'protocols'),
    resolve(config.codevDir, 'protocols'),
    join(getSkeletonDir(), 'protocols'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      readdirSync(dir, { withFileTypes: true })
        .filter((d: Dirent) => d.isDirectory())
        .forEach((d: Dirent) => seen.add(d.name));
    } catch {
      // Ignore unreadable directories
    }
  }
  return Array.from(seen).sort();
}

/**
 * Validate that a protocol exists.
 * Resolves through .codev/ → codev/ → cache → skeleton (via resolveCodevFile),
 * so v3-cleaned projects without local protocols still find the skeleton copy.
 */
export function validateProtocol(config: Config, protocolName: string): void {
  const protocolJson = resolveCodevFile(
    `protocols/${protocolName}/protocol.json`,
    config.workspaceRoot,
  );
  const protocolMd = resolveCodevFile(
    `protocols/${protocolName}/protocol.md`,
    config.workspaceRoot,
  );

  if (!protocolJson && !protocolMd) {
    const dirs = listAvailableProtocols(config);
    const available = dirs.length > 0 ? `\n\nAvailable protocols: ${dirs.join(', ')}` : '';
    fatal(`Protocol not found: ${protocolName}${available}`);
  }

  // #1011: a builder-prompt.md is required to spawn. Fail fast rather than
  // synthesize a degraded fallback prompt that points the builder at
  // codev/protocols/... by literal path (which bypasses the four-tier resolver
  // and breaks fresh installs). Every shipped protocol ships one, so this only
  // fires for a custom/override protocol that omitted it.
  const builderPrompt = resolveCodevFile(
    `protocols/${protocolName}/builder-prompt.md`,
    config.workspaceRoot,
  );
  if (!builderPrompt) {
    fatal(
      `Protocol "${protocolName}" has no builder-prompt.md; cannot build a spawn prompt. ` +
      `Add protocols/${protocolName}/builder-prompt.md.`,
    );
  }

  // #1011: a protocol.json without a protocol.md is permitted, but the builder
  // prompt inlines protocol.md unconditionally — so it would spawn with an empty
  // "## Protocol Reference (full text)" section. Shipped protocols can't hit this
  // (a completeness test enforces every shipped protocol has a protocol.md); this
  // warns (non-fatally) when a project's own custom/override protocol omits it.
  if (protocolJson && !protocolMd) {
    logger.warn(
      `Protocol "${protocolName}" has a protocol.json but no protocol.md; builders will ` +
      `spawn with an empty Protocol Reference section. Add protocols/${protocolName}/protocol.md.`,
    );
  }
}

/**
 * Load and parse a protocol.json file.
 * Resolves through .codev/ → codev/ → cache → skeleton (via resolveCodevFile).
 */
export function loadProtocol(config: Config, protocolName: string): ProtocolDefinition | null {
  const protocolJsonPath = resolveCodevFile(
    `protocols/${protocolName}/protocol.json`,
    config.workspaceRoot,
  );
  if (!protocolJsonPath) {
    return null;
  }
  try {
    const content = readFileSync(protocolJsonPath, 'utf-8');
    return JSON.parse(content) as ProtocolDefinition;
  } catch {
    logger.warn(`Warning: Failed to parse ${protocolJsonPath}`);
    return null;
  }
}

/**
 * Resolve the builder mode (strict vs soft)
 * Precedence: explicit flags > protocol defaults > input type defaults
 */
export function resolveMode(
  options: SpawnOptions,
  protocol: ProtocolDefinition | null,
): 'strict' | 'soft' {
  if (options.strict && options.soft) {
    fatal('--strict and --soft are mutually exclusive');
  }
  if (options.strict) return 'strict';
  if (options.soft) return 'soft';

  if (protocol?.defaults?.mode) {
    return protocol.defaults.mode;
  }

  // Issue-based spawns with non-bugfix protocol default to strict
  if (options.issueNumber && options.protocol !== 'bugfix') return 'strict';
  return 'soft';
}

/**
 * Porch config reader — loads porch.checks from .codev/config.json.
 *
 * Delegates to the unified config loader in lib/config.ts.
 */

import { loadConfig } from '../../lib/config.js';
import { resolveLaneComposition, type ConsultMode } from '../../lib/consult-lanes.js';
import { canonicalProtocolName } from '../../lib/skeleton.js';
import type { CheckOverrides } from './types.js';

/**
 * Resolve which consultation lanes run for a protocol + review type.
 *
 * THE single implementation. `porch next` (which emits the consult commands) and `porch done`
 * (which enforces that a review file exists per lane) previously each carried their own copy, and
 * the copies had drifted in three ways: `done` did no lane-name validation, did not normalize a
 * single-string value into a list, and wrapped config loading in a bare `catch` that turned any
 * config error into a silent fall-back to protocol defaults. Drift between them is not cosmetic —
 * `next` emitting one lane set while `done` demands another is a deadlock the user cannot debug,
 * because neither command prints the set it derived.
 *
 * Precedence is `resolveLaneComposition`'s (config > protocol, most specific first); this wrapper
 * only supplies the config. Validation happens in `loadConfig`, so a malformed lane list throws
 * here rather than resolving to something plausible.
 */
export function resolveConsultationModels(
  workspaceRoot: string,
  protocolModels: string[],
  protocol: string,
  reviewType: string | undefined,
): { models: string[]; mode: ConsultMode } {
  const config = loadConfig(workspaceRoot);
  return resolveLaneComposition(
    config.porch?.consultation,
    protocol,
    reviewType,
    protocolModels,
    workspaceRoot,
  );
}

/**
 * Load check overrides from the unified config (.codev/config.json).
 *
 * Reads only the `porch.checks` section; all other keys are ignored.
 * Returns null when no `porch.checks` key is configured.
 *
 * Throws when config exists but cannot be parsed as JSON,
 * or when the legacy af-config.json is found.
 */
export function loadCheckOverrides(
  workspaceRoot: string,
  protocol?: string,
): CheckOverrides | null {
  const config = loadConfig(workspaceRoot);

  if (typeof config.porch !== 'object' || config.porch === null) {
    return null;
  }

  const checks = config.porch.checks;
  const flat = (typeof checks === 'object' && checks !== null && !Array.isArray(checks))
    ? checks as CheckOverrides
    : null;

  const perProtocol = protocol ? loadProtocolCheckOverrides(config, workspaceRoot, protocol) : null;

  if (!flat && !perProtocol) return null;
  if (!perProtocol) return flat;
  if (!flat) return perProtocol;

  // Field-level merge, per-protocol winning (#33). Wholesale replacement would
  // mean a per-protocol `skip` silently discarded the global `command` for the
  // same check, which is the opposite of what someone writing one line of
  // protocol-specific config expects.
  const merged: CheckOverrides = { ...flat };
  for (const [name, override] of Object.entries(perProtocol)) {
    merged[name] = { ...(flat[name] ?? {}), ...override };
  }
  return merged;
}

/**
 * Per-protocol check overrides from `porch.byProtocol.<name>.checks` (#33).
 *
 * `porch.checks` is one flat map applied to every protocol, and protocols do not
 * declare the same check names: BUGFIX and AIR have `test`, SPIR does not. In a
 * repo with no package.json, overriding `test` is REQUIRED or BUGFIX blocks at
 * the fix phase running `npm test` — and then every `porch status` on a SPIR
 * project warns that `test` is unknown. There was no way to satisfy both.
 *
 * Resolved by canonical protocol name, so `spir` and `spider` are one entry
 * rather than two spellings that silently disagree.
 */
function loadProtocolCheckOverrides(
  config: ReturnType<typeof loadConfig>,
  workspaceRoot: string,
  protocol: string,
): CheckOverrides | null {
  const byProtocol = (config.porch as { byProtocol?: unknown } | undefined)?.byProtocol;
  if (typeof byProtocol !== 'object' || byProtocol === null || Array.isArray(byProtocol)) {
    return null;
  }

  const wanted = canonicalProtocolName(workspaceRoot, protocol);
  for (const [name, entry] of Object.entries(byProtocol as Record<string, unknown>)) {
    if (canonicalProtocolName(workspaceRoot, name) !== wanted) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const checks = (entry as { checks?: unknown }).checks;
    if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) continue;
    return checks as CheckOverrides;
  }
  return null;
}

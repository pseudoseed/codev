/**
 * `codev forge <concept>` — run one forge concept through the real resolver.
 *
 * WHY THIS EXISTS (issue #13)
 *
 * Before this, the only way to invoke a concept from a shell was to name its
 * script by path — `packages/codev/scripts/forge/github/ci-failures.sh`. That
 * path **bypasses resolution**: it skips the `.codev/config.json` lookup, the
 * provider preset, and any per-repo override. A project that overrides
 * `ci-failures` would have its override silently ignored by anyone following
 * those instructions, and would get GitHub's script against a Forgejo repo.
 * That is not hypothetical — the reference Forgejo repo carried three concept
 * overrides until #12 shipped.
 *
 * So this is deliberately a THIN dispatcher and nothing else: resolve the
 * concept exactly as `executeForgeCommand` does, pass the ambient `CODEV_*`
 * environment through, print stdout verbatim, and exit with the script's own
 * exit code. No parsing, no reformatting, no second code path — it delegates to
 * `executeForgeCommandDetailed` so there is exactly one place where a forge
 * command is actually run.
 *
 * The two things it adds are the two ways a caller can be wrong:
 *
 *  - a concept **disabled for this provider** says so by name and exits
 *    non-zero, rather than printing nothing and letting silence read as an
 *    empty answer;
 *  - an **unknown concept name** lists the valid ones.
 */

import {
  executeForgeCommandDetailed,
  getKnownConcepts,
  getForgeCommand,
  loadForgeConfig,
  describeUnavailableConcept,
} from '../lib/forge.js';

export interface ForgeCommandCliOptions {
  /** Workspace root to resolve `.codev/config.json` from. Defaults to cwd. */
  cwd?: string;
  /** Sinks, injectable for tests. Default to the real streams. */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/**
 * Run one concept. Returns the process exit code; never calls process.exit, so
 * the caller (cli.ts) decides and tests can assert.
 */
export async function runForgeConcept(
  concept: string | undefined,
  options: ForgeCommandCliOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const out = options.stdout ?? ((t: string) => process.stdout.write(t));
  const err = options.stderr ?? ((t: string) => process.stderr.write(t));

  const known = getKnownConcepts();

  if (!concept) {
    err(`codev forge: a concept name is required.\nKnown concepts: ${known.join(', ')}\n`);
    return 2;
  }

  if (!known.includes(concept)) {
    err(`codev forge: '${concept}' is not a known forge concept.\nKnown concepts: ${known.join(', ')}\n`);
    return 2;
  }

  const forgeConfig = loadForgeConfig(cwd);

  // Disabled is not an error in the command; it is an answer the caller must be
  // able to see. `describeUnavailableConcept` names the provider or the config,
  // which is the difference between "why is this empty" and "right, Forgejo has
  // no GraphQL".
  if (getForgeCommand(concept, forgeConfig) === null) {
    err(`codev forge: ${describeUnavailableConcept(concept, forgeConfig)}\n`);
    return 3;
  }

  const result = await executeForgeCommandDetailed(concept, undefined, { cwd, forgeConfig });

  // stdout verbatim, including on the failure path: the ci-* concepts print
  // their structured error envelope there precisely so the class of failure
  // survives a non-zero exit.
  if (result.stdout) out(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) err(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);

  if (result.timedOut) {
    err(`codev forge: '${concept}' was killed for exceeding the command timeout\n`);
    // 124 is what timeout(1) uses, and what scripts/forge/_timeout.sh reports
    // internally — so a caller sees the same number wherever the clock ran out.
    return 124;
  }

  return result.exitCode ?? (result.ok ? 0 : 1);
}

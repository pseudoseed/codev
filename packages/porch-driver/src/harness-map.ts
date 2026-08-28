/**
 * Spec 146, Phase 3 — `--harness` to a t3code `driverKind`, `--model` to
 * `modelSelection.model`.
 *
 * WHY A TABLE AND NOT A PASS-THROUGH
 *
 * `driverKind` is a t3code slug, and Codev's harness names are not it. The five
 * kinds are `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`
 * (`packages/contracts/src/model.ts:130-134` at the pinned commit). Codev's
 * `--harness claude` is **`claudeAgent`**. Two of the five match by accident, and
 * that is exactly the shape that makes a mapping look unnecessary until the third
 * one silently spawns the wrong driver.
 *
 * WHY THE MODEL CHECK STAYS STATIC
 *
 * t3code validates a model dynamically: it normalises through
 * `MODEL_SLUG_ALIASES_BY_PROVIDER` and takes the real list from the provider's
 * live `model/list` response. Codev validates statically, in
 * `assertHarnessAcceptsModel`. The deliverable says an unsupported pair must fail
 * **at spawn, matching today's behaviour**, and matching it means keeping the
 * static check: the dynamic one cannot answer before a provider snapshot exists.
 * A pair that passes here and is then rejected by t3code is a second, later
 * failure — a different fact, and it must not be spelled like this one.
 *
 * WHY THIS FILE DOES NOT IMPORT `agent-farm/utils/harness.ts`
 *
 * That module reaches config, the filesystem and the built-in provider table, and
 * lives in the published server package. This one is a pure mapping so it can be
 * tested without a workspace. The set of model-accepting harnesses is therefore
 * duplicated as data and injectable — `acceptsModel` — rather than imported. The
 * duplication is asserted against the real table by a test, so the two cannot
 * drift silently.
 */

/** The driver kinds t3code accepts, at the pinned contract commit. */
export const T3_DRIVER_KINDS = ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode'] as const;

export type T3DriverKind = (typeof T3_DRIVER_KINDS)[number];

/**
 * Codev harness name to t3code driver kind.
 *
 * Only Codev's three built-ins are here. `cursor` and `grok` are driver kinds
 * with no Codev harness — reachable through t3code, not through `--harness`.
 */
export const HARNESS_TO_DRIVER_KIND: Readonly<Record<string, T3DriverKind>> = Object.freeze({
  claude: 'claudeAgent',
  codex: 'codex',
  opencode: 'opencode',
});

/**
 * Codev harness names that expose a model selector.
 *
 * Mirrors the harnesses whose provider defines `buildModelArgs` /
 * `buildScriptModelArg`. A test asserts this set equals the real one.
 */
export const HARNESSES_ACCEPTING_MODEL: ReadonlyArray<string> = Object.freeze([
  'claude',
  'codex',
  'opencode',
]);

/**
 * Harness names Codev retired. Answering these with "unknown" would be a
 * different and wrong fact: the name was real, and the reason it no longer works
 * is not that nobody has heard of it.
 */
export const RETIRED_HARNESS_NAMES: ReadonlyArray<string> = Object.freeze(['gemini']);

/** Base for every failure this module raises, so a caller can scope one `catch`. */
export class HarnessMappingError extends Error {
  constructor(
    readonly harnessName: string,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessMappingError';
  }
}

/** The name is not one this mapping knows — a custom harness, or a typo. */
export class UnmappedHarnessError extends HarnessMappingError {
  constructor(harnessName: string) {
    super(
      harnessName,
      `No t3code driver for the "${harnessName}" harness.\n` +
        `Mapped harnesses: ${Object.keys(HARNESS_TO_DRIVER_KIND).join(', ')}.\n` +
        `A custom harness is a local command; t3code runs its own drivers, so there ` +
        `is nothing to map it onto. This is not "the pair is unsupported" — the ` +
        `harness itself has no driver.`,
    );
    this.name = 'UnmappedHarnessError';
  }
}

/** The name was a Codev built-in and is retired. */
export class RetiredHarnessMappingError extends HarnessMappingError {
  constructor(harnessName: string) {
    super(
      harnessName,
      `The "${harnessName}" harness is retired in Codev, so it is not mapped to a ` +
        `t3code driver.\n` +
        `Mapped harnesses: ${Object.keys(HARNESS_TO_DRIVER_KIND).join(', ')}.`,
    );
    this.name = 'RetiredHarnessMappingError';
  }
}

/**
 * A model was requested for a harness with no model selector.
 *
 * Named to match `ModelUnsupportedError` in `agent-farm/utils/harness.ts`, which
 * is the behaviour this reproduces, but distinct so a caller can tell which layer
 * refused.
 */
export class ModelUnsupportedForDriverError extends HarnessMappingError {
  constructor(harnessName: string, flag: string) {
    super(
      harnessName,
      `${flag} is not supported for the "${harnessName}" harness — it exposes no ` +
        `model selector.\n` +
        `Harnesses that accept a model: ${HARNESSES_ACCEPTING_MODEL.join(', ') || '(none)'}.`,
    );
    this.name = 'ModelUnsupportedForDriverError';
  }
}

/**
 * The `modelSelection` shape a t3code command carries.
 *
 * `model` is required by the contract; `instanceId` names the provider instance.
 */
export interface ModelSelection {
  readonly instanceId?: string | null;
  readonly model: string;
}

export interface HarnessMappingOptions {
  /** The `--model` value, if one was given. */
  readonly model?: string;
  /** The provider instance to run under. Defaults to the driver kind. */
  readonly instanceId?: string;
  /**
   * Does this harness expose a model selector? Injected so a caller holding the
   * real provider table (custom harnesses included) can answer authoritatively.
   */
  readonly acceptsModel?: (harnessName: string) => boolean;
  /** Flag name for the error message. */
  readonly flag?: string;
}

export interface HarnessMapping {
  readonly driverKind: T3DriverKind;
  /** Absent when no `--model` was given: the server picks its default. */
  readonly modelSelection?: ModelSelection;
}

/**
 * Map a Codev harness name and optional model onto t3code's spawn inputs.
 *
 * Throws at spawn — never returns a partial mapping — because a driver kind we
 * could not resolve and a model we could not honour are both facts the caller
 * must act on before a thread exists, not after one is running under the wrong
 * driver.
 */
export function mapHarness(harnessName: string, options: HarnessMappingOptions = {}): HarnessMapping {
  if (RETIRED_HARNESS_NAMES.includes(harnessName)) {
    throw new RetiredHarnessMappingError(harnessName);
  }

  const driverKind = Object.prototype.hasOwnProperty.call(HARNESS_TO_DRIVER_KIND, harnessName)
    ? HARNESS_TO_DRIVER_KIND[harnessName]
    : undefined;
  if (!driverKind) throw new UnmappedHarnessError(harnessName);

  if (options.model === undefined) return { driverKind };

  const accepts = options.acceptsModel ?? ((name: string) => HARNESSES_ACCEPTING_MODEL.includes(name));
  if (!accepts(harnessName)) {
    throw new ModelUnsupportedForDriverError(harnessName, options.flag ?? '--model');
  }

  return {
    driverKind,
    modelSelection: {
      instanceId: options.instanceId ?? driverKind,
      model: options.model,
    },
  };
}

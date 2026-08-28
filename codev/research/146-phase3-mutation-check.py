"""Confirm a Phase 3 test actually fails without the behaviour it names.

NOT every property here is mutation-checkable, and the ones that are not are left
out rather than listed with a green that means nothing. Specifically: `checks.ts`
resolves on `exit` rather than `close` AND spawns `detached`, and on this platform
either one alone bounds a compound command (measured: close+attached 20,018ms,
exit+attached 705ms, close+detached 706ms). No test can go red for reverting just
one, so no mutation claims otherwise. The grandchild test does discriminate
`detached`. The same is true of the post-exit drain grace: on this platform the
pipes are already empty when `exit` fires at the sizes a test can produce, so
resolving immediately passes too. The grace stays because the guarantee is about
the case that does not reproduce on demand, and the output-completeness test stays
because it would catch a real truncation — but neither claims a red it cannot
produce.

Same discipline as `146-phase2-mutation-check.py`: revert one property at a time,
run the single test that claims it, put the file back in a `finally`. A test that
passes with the property removed is not evidence of the property.

Run from the repo root:  python3 codev/research/146-phase3-mutation-check.py
"""
import subprocess

DRIVER = 'packages/porch-driver/src'
TEST = 'packages/codev/src/__tests__/spec-146-porch-driver.test.ts'

MUTATIONS = [
    (
        f'{DRIVER}/commands.ts',
        "  journal.recordIntent(commandId, command.type, payload);\n  await options.beforeDispatch?.();\n",
        "  await options.beforeDispatch?.();\n",
        'writes the intent BEFORE the command is dispatched',
    ),
    (
        f'{DRIVER}/commands.ts',
        "  journal.recordIntent(commandId, command.type, payload);\n  await options.beforeDispatch?.();\n",
        "  await options.beforeDispatch?.();\n",
        'a crash between the journal write and the dispatch leaves the command pending',
    ),
    (
        f'{DRIVER}/commands.ts',
        "      await dispatcher.call(DISPATCH_METHOD, intent.command);",
        "      await dispatcher.call(DISPATCH_METHOD, { ...intent.command, commandId: newCommandId() });",
        'recovery re-dispatches under the SAME commandId, so the server can dedupe',
    ),
    (
        f'{DRIVER}/commands.ts',
        "        throw new JournalCorruptError(this.path, index + 1, (error as Error).message);",
        "        return;",
        'a torn LAST line is recovered; a torn middle line is reported',
    ),
    (
        f'{DRIVER}/commands.ts',
        "    if (isServerRefusal(error)) journal.recordOutcome(commandId, 'failed', (error as Error).message);",
        "    journal.recordOutcome(commandId, 'failed', (error as Error).message);",
        'a command left UNANSWERED stays pending, because absent is not negative',
    ),
    (
        f'{DRIVER}/commands.ts',
        "  return (error as { name?: unknown } | null)?.name === 'RpcFailureError';",
        "  return true;",
        'an unrecognised error is treated as unanswered, not as a refusal',
    ),
    (
        f'{DRIVER}/cursor.ts',
        "    await handler();\n    await options.beforeAdvance?.(sequence);\n    this.#persist(sequence);",
        "    this.#persist(sequence);\n    await handler();\n    await options.beforeAdvance?.(sequence);",
        'advances only after the handler completes',
    ),
    (
        f'{DRIVER}/cursor.ts',
        "    await handler();\n    await options.beforeAdvance?.(sequence);\n    this.#persist(sequence);",
        "    this.#persist(sequence);\n    await handler();\n    await options.beforeAdvance?.(sequence);",
        'a crash between the handler and the cursor write REPROCESSES the event',
    ),
    (
        f'{DRIVER}/cursor.ts',
        "    if (sequence <= this.#applied) return 'duplicate';",
        "    if (sequence < 0) return 'duplicate';",
        'skips a redelivered sequence instead of re-running its handler',
    ),
    (
        f'{DRIVER}/cursor.ts',
        "  reset(sequence: number): void {\n    this.#persist(sequence);",
        "  reset(sequence: number): void {\n    if (sequence <= this.#applied) return;\n    this.#persist(sequence);",
        'reset moves the cursor BACKWARDS, which is the case it exists for',
    ),
    (
        f'{DRIVER}/cursor.ts',
        "    if (!Number.isInteger(value) || value < 0) throw new CursorUnreadableError(path, raw);",
        "    if (!Number.isInteger(value) || value < 0) return new PersistentCursor(path, 0);",
        'an absent cursor file is a cold start; an unreadable one is an error',
    ),
    (
        f'{DRIVER}/turn.ts',
        "    if (waiter?.seenRunning) {",
        "    if (waiter) {",
        'does NOT report settled on the thread-creation event',
    ),
    (
        f'{DRIVER}/turn.ts',
        "  const expectation = tracker.expectTurn(options.threadId);\n  const messageId = newCommandId();\n\n  const { commandId } = await dispatchCommand(",
        "  const messageId = newCommandId();\n\n  const { commandId } = await dispatchCommand(",
        'registers the waiter before the command is dispatched',
    ),
    (
        f'{DRIVER}/turn.ts',
        "    if (event.sequence > previous) this.#lastSequence.set(event.aggregateId, event.sequence);",
        "    this.#lastSequence.set(event.aggregateId, event.sequence);",
        'lastSequence never goes backwards on a redelivery',
    ),
    (
        f'{DRIVER}/harness-map.ts',
        "  claude: 'claudeAgent',",
        "  claude: 'codex',",
        'maps claude to claudeAgent, not to claude',
    ),
    (
        f'{DRIVER}/harness-map.ts',
        "  if (!driverKind) throw new UnmappedHarnessError(harnessName);",
        "  if (!driverKind) return { driverKind: 'claudeAgent' };",
        'refuses an unknown harness rather than falling back to a default driver',
    ),
    (
        f'{DRIVER}/harness-map.ts',
        "  if (RETIRED_HARNESS_NAMES.includes(harnessName)) {\n    throw new RetiredHarnessMappingError(harnessName);\n  }\n",
        "",
        'answers a retired harness with retirement, not with "unknown"',
    ),
    (
        f'{DRIVER}/harness-map.ts',
        "  if (options.model === undefined) return { driverKind };",
        "  if (options.model === undefined) return { driverKind, modelSelection: { model: '' } };",
        'omits modelSelection entirely when no model was given',
    ),
    (
        f'{DRIVER}/checks.ts',
        "      detached: true,",
        "      detached: false,",
        'the timeout kills a backgrounded grandchild, not just the shell',
    ),
    (
        f'{DRIVER}/checks.ts',
        "  return { text: combined.slice(combined.length - cap), truncated: true };",
        "  return { text: combined, truncated: false };",
        'caps captured output and says it did',
    ),
    (
        f'{DRIVER}/commands.ts',
        "    this.#truncateTornTail();\n    const fd = openSync(this.path, 'a');",
        "    const fd = openSync(this.path, 'a');",
        'appending after a torn tail does not corrupt the journal',
    ),
    (
        f'{DRIVER}/thread.ts',
        "    if (!mapping.modelSelection) {\n      throw new ModelSelectionRequiredError(options.harnessName);\n    }",
        "",
        'refuses to create a thread with no model at all',
    ),
    (
        f'{DRIVER}/thread.ts',
        "    const turnId = await this.#withTimeout(started.running, remaining(), 'the turn to start');\n    await this.#withTimeout(started.settled, remaining(), 'the turn to settle');",
        "    const turnId = await this.#withTimeout(started.running, options.timeoutMs, 'the turn to start');\n    await this.#withTimeout(started.settled, options.timeoutMs, 'the turn to settle');",
        'spends ONE budget across a turn, not one per wait',
    ),
    (
        f'{DRIVER}/harness-map.ts',
        "export const RETIRED_HARNESS_NAMES: ReadonlyArray<string> = Object.freeze(['gemini']);",
        "export const RETIRED_HARNESS_NAMES: ReadonlyArray<string> = Object.freeze(['gemini', 'cursor']);",
        "the retired list matches Codev's own",
    ),
    (
        f'{DRIVER}/checks.ts',
        "        exitCode: exitCode,",
        "        exitCode: exitCode ?? 0,",
        'a timeout is spelled differently from a failure',
    ),
    (
        f'{DRIVER}/thread.ts',
        "    if (this.isTurnActive) throw new TurnActiveError(this.threadId);",
        "",
        'refuses a phase check while a turn is active',
    ),
    (
        f'{DRIVER}/worktree-setup.ts',
        "      guard: 'absent',",
        "      guard: 'not-applicable',",
        'reports an absent guard rather than silently omitting it',
    ),
    (
        f'{DRIVER}/worktree-setup.ts',
        "      guard: 'absent',",
        "      guard: 'not-applicable',",
        'distinguishes "no guard supplied" from "no guard applies"',
    ),
    (
        f'{DRIVER}/worktree-setup.ts',
        "        if (Array.isArray(existing.instructions) && Array.isArray(incoming.instructions)) {",
        "        if (false) {",
        'merges an existing opencode.json rather than overwriting it',
    ),
]

for path, fixed, unfixed, test_name in MUTATIONS:
    original = open(path).read()
    if fixed not in original:
        print(f'SKIP  {test_name}: anchor not found in {path}')
        continue
    try:
        open(path, 'w').write(original.replace(fixed, unfixed, 1))
        r = subprocess.run(
            ['npx', 'vitest', 'run', TEST.replace('packages/codev/', ''), '-t', test_name],
            capture_output=True, text=True, cwd='packages/codev',
        )
    finally:
        open(path, 'w').write(original)
    verdict = 'FAILS without it (good)' if r.returncode != 0 else 'STILL PASSES -- the test is not pointed at the property'
    print(f'{verdict}: {test_name}')

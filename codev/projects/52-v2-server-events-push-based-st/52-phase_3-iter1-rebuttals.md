# Phase 3 rebuttal — iteration 1

Claude REQUEST_CHANGES HIGH. Gemini skipped, Codex quota-exhausted, opencode timed out. All three blocking defects accepted.

## Must-fix

- **Tick buckets scoped.** `tick()` still advances rings globally, but each connected scope now gets only in-scope builder ids. Test: workspace B output does not appear in A's tick.
- **Case-insensitive terminal lookup.** `lookupBuilderTerminal` lowercases registry keys, used by `sessionForRole` / `lastDataAt` / `bytesWritten`.
- **Mailbox summary memoized per workspace per `now`.** One GROUP BY per compare, not per node.

## Accepted, non-blocking, done this pass

- Route↔sampler wiring test: `setV2SamplerForTests` + snapshot `buckets` from the ring.

## Not doing this phase

- Caching `discoverBuilders` / dropping the 100ms baseline. The plan requires 100ms; watch-wake still exists. Idle CPU is a Phase 4 measurement if it fails the bound.

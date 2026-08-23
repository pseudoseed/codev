# Experiment 77: Measure Tower CPU and event-loop delay with the v2 sampler

**Status**: Aborted · **Date**: 2026-08-23

Issue #77. Cancelled by architect:uiv2 before any `/v2/events` connection and before any measurement.

The number cannot change the action. If the sampler is expensive under filesystem churn, debounce the watcher. If it is cheap, debounce anyway: `fs.watch` fires in bursts and coalescing is correct on its own terms.

Not run. No CPU series, no delay series, no wake count. Tower was not restarted. Production files were not edited.

`tower.log` had zero `/v2/` lines on this process (PID 61941, `@cluesmith/codev@3.3.1`) when the task stopped. That fact is only context for anyone who later reopens the question; it is not a finding.

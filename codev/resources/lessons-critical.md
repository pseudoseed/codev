# lessons-critical.md — Always-On Engineering Wisdom (HOT tier)

<!-- HOT tier: capped lessons + a bounded map of lessons-learned.md. Always injected into
every porch phase prompt and into CLAUDE.md/AGENTS.md. CAP: <=10 lessons, <=12 map topics,
<=35 lines. To add a lesson, DEMOTE a weaker one into lessons-learned.md (displacement).
MAINTAIN polices the cap and keeps the map in sync with lessons-learned.md's sections. -->

## Critical lessons (consult before deciding)
- Trust the protocol — never skip CMAP/consultation; it catches security, design, and protocol issues solo review misses.
- Check for existing work (PRs, git history) before building from scratch.
- "It compiled" / "tests pass" is not "it works" — verify the real user path end-to-end before calling it done.
- "I could not tell" must never be spelled the same way as "no". A truncation, an unreachable API, and a server too old to answer each need their own signal and must emit nothing else — a partial or empty answer reads as a complete, negative one.
- Single source of truth beats distributed state — consolidate duplicates rather than syncing them.
- After any rename or framework change, grep the whole repo across BOTH codev/ and codev-skeleton/ before claiming "all fixed."
- A test that cannot fail is not a test — revert the fix and confirm the test fails before trusting it. Distinct from the "could not tell" rule above: that one is about a check reporting honestly, this is about whether it can report at all.
- A test that constructs the collaborator itself proves the collaborator works, never that production constructs it — assert the wiring against the production source too.
- "Who calls this in production?" grep before changing a long-lived API — vestigial code survives.
- Verify reviewer/plan claims against the actual file before acting — summaries are evidence, not ground truth.

## Map of lessons-learned.md (consult when…)
- Critical — before any high-blast-radius change.
- Security — handling input, auth, paths, or HTML/shell.
- Architecture — choosing a design or abstraction.
- Process — planning phases or scoping work.
- Testing — writing tests or picking a harness.
- UI/UX — changing views, status indicators, or accessibility.
- Documentation — editing docs or the skeleton.
- 3-Way Reviews — interpreting CMAP feedback.
- Protocol Orchestration — touching porch, state, or gates.
- Debugging and Root Cause Analysis — stuck on a bug.

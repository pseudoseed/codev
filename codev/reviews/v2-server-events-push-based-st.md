# Review: v2 server events — push-based status for the v2 hierarchy

See `codev/reviews/52-v2-server-events.md` for the full review.

## Architecture Updates

No architecture updates needed — the stream has not been run against a live Tower; the plan deferred `arch.md` until then. Hot tier is at cap and this is spec-narrow, not a displacement candidate.

## Lessons Learned Updates

- Routed: cold — Testing — Vitest cwd is `packages/codev`; git pathspecs in tests must pass `cwd: git rev-parse --show-toplevel` or they silently match nothing.
- No hot lesson. Cap is full; this is not cross-cutting enough to displace.

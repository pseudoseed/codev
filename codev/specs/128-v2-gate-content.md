# Spec 128 — Gate content the v2 gate card can render

**Issue:** #128
**Status:** draft
**Author:** architect:uiv2

## Problem Statement

The approved v2 design renders a blocked builder as a **gate card**: it shows what decision is
being asked for, what the choices are, and what each choice causes. The system records none of
that.

`blockedGate` is a bare string (`packages/types/src/api.ts:188`, `blockedGate: string | null`)
carrying only a gate *name* — `plan-approval`, `pr`, `verify-approval`. `GateStatus` in
`packages/codev/src/commands/porch/types.ts:152` is three fields:

```ts
export interface GateStatus {
  status: 'pending' | 'approved';
  requested_at?: string;
  approved_at?: string;
}
```

There is no question, no choice set, no consequence, and nowhere to put one. A card built on
today's data can only print a name and a timestamp, which is the information the sidebar
already gives. The design's reason for existing — letting a human decide without opening the
worktree — cannot be built.

## Current State

**What exists.** When a builder reaches a gate, porch sets `gates[<name>].status = 'pending'`
with `requested_at`, commits `status.yaml`, and the builder separately sends an
`afx send architect` message written in prose. Tower reads `status.yaml`, and the v2 stream
publishes `blockedGate` as the gate name.

**Where the content actually lives today.** In that prose message, and only there. It is
persisted — `afx send` is mailbox-first (Spec 1313) and the message row sits in
`~/.agent-farm/global.db`. It typically does contain the question and the trade-offs, because
the builder wrote it for a human.

**Why reusing it was rejected.** Reconstructing `{question, choices[], consequence}` from that
prose means parsing free text an agent composed. It works until a builder phrases a gate
differently, and it degrades silently rather than loudly — the card renders a name and a
paragraph, and nothing reports that it failed. This was evaluated as option B and ruled against
on issue #128; the ruling is recorded there.

**The adjacent constraint.** `status.yaml` is written by porch only. Nothing else may write it,
and it is never hand-edited. Any new content has to arrive through a porch code path.

## Desired State

Porch records gate content as **structured data** at the moment it requests a gate, the v2
stream carries it, and the gate card renders fields rather than prose.

### The record

`GateStatus` gains an optional `request` block. Optional is load-bearing: every existing
`status.yaml` on disk and on `main` stays valid and keeps working, and a gate with no `request`
renders exactly as it does today.

```ts
export interface GateRequest {
  question: string;                 // the decision, one sentence
  choices: Array<{
    label: string;                  // what the human picks
    consequence: string;            // what that choice causes
    recommended?: boolean;          // at most one
  }>;
  context?: string;                 // optional short framing, not a report
}

export interface GateStatus {
  status: 'pending' | 'approved';
  requested_at?: string;
  approved_at?: string;
  request?: GateRequest;            // new, optional
}
```

### The wire

`blockedGate: string | null` stays as it is — renaming it would churn every consumer for no
gain. A sibling field carries the content:

```ts
blockedGate: string | null;
blockedGateRequest: GateRequest | null;   // new
```

`null` whenever the gate has no recorded request, which is every gate that predates this
change.

### The producer

The phase prompts that drive a builder to a gate must ask for these fields, and `porch gate`
must accept and persist them. A builder that supplies nothing still reaches the gate — the
gate is not blocked on having content, because a gate that cannot be requested is worse than a
gate with a thin card.

### The skeleton

`codev-skeleton/` carries the same protocol vocabulary, so adopters get structured gates rather
than a fork-only feature. Per the repo's dual-tree rule, the framework change lands in both
trees.

### The notification stays

The `afx send architect` gate message is unchanged. It is the human *notification*; the
`request` block is the *record*. They serve different purposes and neither replaces the other.

## Goals

1. A human can act on a gate from the card alone, without opening the worktree.
2. Every existing `status.yaml` keeps working with no migration step.
3. Adopters get it, not just this fork.
4. A gate with no recorded content is visibly thin, never silently wrong.

## Non-Goals

- **Approving from the card.** Approval requires `--a-human-explicitly-approved-this` at a
  terminal, and that stays true. This spec makes a gate *legible*, not *actionable*.
- Backfilling content for gates already recorded.
- Parsing existing prose gate messages into fields.
- Changing which gates exist or when they fire.

## Constraints

- `status.yaml` is written by porch only; never hand-edited.
- `GateStatus.request` must be optional — no migration, no rewrite of committed state.
- Framework changes land in `codev/` **and** `codev-skeleton/`.
- The two human gates and the pr gate keep their existing semantics.

## Success Criteria

1. `GateStatus.request` exists, is optional, and a `status.yaml` written before this change
   loads and renders without error or warning.
2. `porch gate` persists a supplied `request` block into `status.yaml` through the normal
   write-and-commit path, and no other code path writes it.
3. The v2 stream publishes `blockedGateRequest` on a builder node, `null` when absent.
4. The v2 gate card renders question, choices and per-choice consequence from that field, and
   renders its existing name-only form when the field is `null` — the thin case is visibly
   thin, not blank and not fabricated.
5. The skeleton's protocol definitions carry the same vocabulary, verified by diffing the two
   trees.
6. A gate requested with no content still reaches `pending` and still notifies the architect.

## Test Scenarios

1. **Legacy state** — load a `status.yaml` with a `pending` gate and no `request`; the node
   publishes `blockedGateRequest: null` and the card renders name-only.
2. **Full request** — a gate with a question and three choices, one `recommended`; all three
   render with their consequences and the recommendation is marked.
3. **Partial request** — `question` present, `choices` empty; renders the question and does not
   invent choices.
4. **Approval unchanged** — approving a gate that carries a `request` follows the identical
   path and still requires the human flag.
5. **Skeleton parity** — the protocol vocabulary is byte-identical across both trees.

## Open Questions

1. Should `choices` be capped in length for rendering, or is that purely the card's problem?
2. Does `context` earn its place, or is `question` enough? Bias toward dropping it — an
   optional free-text field is where prose creeps back in.

## References

- Issue #128, including the architect ruling that chose this over the mailbox-reuse approach
- Spec 83 (`codev/specs/83-v2-client-shell.md`), D3 and D8 — how status maps to the design
- Spec 1313 — `afx send` mailbox-first delivery
- `packages/codev/src/commands/porch/types.ts:152` — `GateStatus`
- `packages/types/src/api.ts:188` — `blockedGate`

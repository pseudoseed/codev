# Phase 7, iteration 1 — what the two lanes said and what changed

**Both lanes APPROVE at HIGH confidence.** No blocking issues. Claude raised four non-blocking
notes; all four are acted on rather than argued with, because all four are right.

## 1. `data-codev-builder-count` was two derivations of one fact — FIXED

> `data-codev-builder-count` is populated from the render-side run scan, not from
> `entry.builderCount`. Two independent derivations of one fact, and the Playwright assertion
> validates only the scan.

Correct, and it is the shape of defect this project has shipped five times: a check that can only
ever agree with the thing it is checking. The attribute now comes from `entry.builderCount`, so the
DOM carries what the GROUPING decided while the rows beneath it carry what was DRAWN — and the
Playwright test asserting `data-codev-builder-count="3"` alongside three builder rows is a real
cross-check instead of a tautology.

## 2. The tree covers the Active section only, undocumented outside code comments — RECORDED

> Deliberate and handled, but undocumented outside code comments.

Recorded in `codev/reviews/250-t3code-front-end-customization.md` under "The tree covers the Active
section only, and phase 8 inherits that", with the consequence spelled out: a phase that assumes
every Codev thread is in the tree is wrong for any thread the user has pinned, snoozed or settled.

## 3. No package.json script for the spec-250 Playwright config — ADDED

`packages/codev` gains `test:e2e:spec250`. The command previously existed only in a config comment
and a skip string, which is the wrong place for the one thing a reader needs to run.

## 4. `props.projectTitle ?? props.codevRoleLabel ?` reads ambiguously — PARENTHESISED

`??` does bind tighter and the expression was correct. Parenthesised anyway: a reader who has to
check an operator precedence table to know whether a line is a bug is paying a cost the parentheses
would have saved.

## What neither lane raised

Neither lane questioned the `alsoVisible` / `parent-elsewhere` addition, the decision to keep
`parent-not-architect` outranking section membership, or the choice to leave orphans outside the
project headings. Recorded so a later reader knows those went unchallenged rather than unnoticed —
they are in the diff both lanes said they read.

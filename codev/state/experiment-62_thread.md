# experiment-62 thread

Builder: experiment-62. Soft EXPERIMENT. Issue #62, not spec 0062.

Spawn prompt pointed at `codev/specs/0062-secure-remote-access.md`. That is the same template-fill collision as 38 and 39. Real work is porch project `62-spike-v2-ui-can-a-finger-drag-`: can a finger drag a dockview split on a real iPad.

## 2026-08-23 hypothesis

Locked in `codev/experiments/62-finger-drag-dockview/notes.md` before any prototype.

Question: can a person drag a split in dockview 8.2.0, on a real iPad, with a finger.

Three issue outcomes stay as written. Playwright is not evidence. Device step stops and asks.

Page is on :4112. Package probe passed (pointer backend + 250ms long-press in `dockview-core@8.2.0`). Stock sash is 4px / 24px coarse. Stopped for the iPad.

URL: `http://10.10.50.186:4112/`

`apps/web` was not edited.

## 2026-08-23 first device result: FR-22 SEPARATION FAILURE

He tapped a tab and closed it. X is inside the tab. Gap tab-hit to X-hit: **0 pt**. `artifacts/tab-x-gap.json`.

Weighted as a failure. Destructive (closes pane / terminal / builder). First contact. FR-22 now fails size (sash 4/24) and separation (0 pt) independently.

## 2026-08-23 device finished

Arm A: gestures and selection pass. Touch targets fail FR-22 on both clauses. His words: split/drag/resize usable, selection and copy work, one failure the nested X, everything else worked.

Arm B was never built. Issue comments added the two-arm bake-off. I shipped only A. No B score. Will not invent one.

#66 takes destructive close as FR-49, library-independent.

Notes wrapped. PR next. Refs #62, not Closes: bake-off incomplete.

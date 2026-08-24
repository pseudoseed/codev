# air-112 — v2 site view fidelity (issue #112, folds in #111)

## What the gap actually was

Spec 83 shipped the structure of `01-site.png` and none of its reading aids. Compared
side by side, the tokens, containment and rust discipline all matched; what was missing
was every cue that tells you *what kind of thing* a row is. Four node kinds rendered as
four bare strings and the hierarchy could only be read off the indentation — which is
the outline FR-1 rejects.

Worked from the PNG and from `01-site.html` (the extracted markup), not from the issue's
description of them. Screenshotted the shipped render and the new one at each step.

## What I changed

- **Label prefixes.** `workspace / <name>`, `architect/<name>`, `builder/<name>`. The bare
  name stays in its own span (`.ws-plot-label`, and the text node in `.stake-name`) so the
  existing selectors and the new ones can address name and kind separately.
- **Glyphs.** The mockup uses Font Awesome; a CDN font is not a build target, so the
  folder-tree and drafting-compass marks are inline paths in `Glyph.tsx` taking
  `currentColor`.
- **Header bar.** `Porch` mark plus `SITE REGISTER · N WORKSPACES · N BUILDERS`. The
  mockup's machine count, find-node and add-machine are absent: the stream is
  single-machine and those two are later units.
- **Machine row.** Moved the hostname out of the top bar into the mockup's machine
  heading: status dot, hostname, `THIS MACHINE`, and an `ONLINE` pill driven by the
  connection state. No hardware description, no load figure — `V2NodeKind` is
  workspace|architect|builder and the wire carries neither.
- **Sparkline baseline.** Bars drew at their literal value, so an all-zero trace was
  zero-height. Every bar now gets a 3px floor and zero buckets take a muted class, so an
  idle builder reads as quiet instead of broken. Active bars follow the existing colour
  discipline (moss running, ochre stalled).
- **Architect status is a dot**, as in the mockup. It keeps its `stamp-*` class and takes
  the dot colour from `currentColor`, so colour discipline and every existing selector
  still hold.
- **Empty-lot placeholder.** `RECONNECT TO RESUME` in a dashed box, but only when the
  workspace is unreachable *and* has nothing under it. A live workspace with nothing
  running is empty for a different reason and gets no copy.
- **Gate stake** turns rust (border plus the 3px stake), matching the mockup. Still the
  only place rust appears besides the GATE stamp.
- **#111**: `.plot-grid` got `align-items: start`. One line, and it was compounding
  everything else — every plot was as tall as the tallest in its row.

## Testing

`fidelity.test.tsx` is the check the suite had no equivalent of. The existing component
tests assert that a name renders, which is exactly why a missing prefix sailed through:
`b1` is present whether or not `builder/` precedes it. The new fixture mirrors the
mockup's own data (checkout / checkout-v3 / pay-2201 / pay-2189) and asserts the prefix
per kind, the register counts, the idle floor, and that the reconnect copy appears only
where it is true.

e2e gained the same checks against real CSS in a browser, plus a direct #111 assertion:
two workspaces of different content must have different heights.

Verified visually, not just green: screenshotted the shipped `/v2/` render, then the new
build against the same live Tower stream, and compared both against `01-site.png`.

The sandbox will not let a dev server bind, so the visual check ran by navigating to the
real `/v2/` origin under Playwright and routing only the static assets to the local
`dist/`. `/api/workspaces` and `/v2/events` stayed real.

## Constraints checked

`git diff --stat` on the C1/C2 frozen set (apps/web, tower.html, apps/vscode,
apps/streamdeck, tower-server.ts, pty-session.ts, tower-routes.ts, v2-routes.ts) is
empty. No Tailwind, no CDN font, no charting library, no `setInterval`.

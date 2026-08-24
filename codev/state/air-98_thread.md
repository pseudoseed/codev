# air-98 — dark workspace re-evaluated on the sampler cadence

Issue: GET /v2/events decided dark once at connect. A path that became readable stayed dark; a path that became unreadable stayed live.

Fix is in the sampler. `scopes` already held every path; `filterByScope` dropped the dark ones and never looked again. Each `compare()` now classifies known/readable, emits `dark` when a live path goes dark (reason change too), and puts a recovered path back in the filter so the existing node/gone walk brings it back. `dark` is a buffered bus delta so resume replays it. Connect-time `darkFrame` (shared snapshot seq) is unchanged.

Client: a workspace `node` clears that entry in `darkPaths`. Spec 83 said dark only cleared on snapshot because the server never sent a recovery; gone still does not clear dark.

No baked decisions on the issue.

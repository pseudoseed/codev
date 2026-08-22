# Policy scores (written after the run, against the pre-locked cases)

Cases from notes.md Goal. Pass means the policy meets FR-38 for that case.

| Case | follow-focused | ignore-hidden | per-viewer-reflow |
|---|---|---|---|
| Two visible, different sizes | PASS. PTY stays at focused 80x24. iPad resize ignored. | FAIL. Second visible attach applies 40x12. Last writer wins. | FAIL for FR-38 as a working policy. Returns `unsupported-divergent`. Additive wrapper cannot reflow. |
| Focused disconnect | PASS. Remaining visible viewer is promoted and applied. | n/a (no focus). Remaining visible can still apply on next resize. | Still unsupported if sizes differ. |
| Both hidden | PASS. No apply. Last negotiated size holds. | PASS. Hidden resize ignored. | PASS. Holds. |
| iOS-style reconnect | PASS. Reattach is unfocused. Nudge ignored while desktop is focused. Sole reconnector applies. | FAIL. Visible reconnector applies immediately and steals size. | FAIL. Divergent sizes stay unsupported. |

Chosen: **follow-focused**.

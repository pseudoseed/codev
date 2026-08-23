# Phase 4 rebuttal — iteration 2

Claude REQUEST_CHANGES HIGH. opencode APPROVE. Blocking defect accepted.

## Must-fix

- **`seedScope` no longer overwrites `filterByScope`.** It unions the new filter with the existing one so a dark second connect cannot shrink a live scope and fire `gone`. Test: live client A receives no `gone` when B connects with `isReadable: false`.

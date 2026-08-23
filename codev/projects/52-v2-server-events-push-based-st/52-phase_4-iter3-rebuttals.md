# Phase 4 rebuttal — iteration 3

Claude REQUEST_CHANGES HIGH. opencode timed out. Blocking defect accepted.

## Must-fix

- Scenario 8 now restores a non-empty workspace after the 100 mutations, asserts `nodes.size > 0`, and compares bucket-stripped nodes so snapshot vs delta cannot look like a mismatch.

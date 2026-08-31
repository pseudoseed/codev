# Phase 6, iteration 2 — response to the 2-way review

**Both lanes APPROVE at HIGH confidence.** One non-blocking note, accepted and fixed.

## claude — the wire-evidence guard can flake on a fresh clone

The mtime comparison assumed the filesystem records when a file was written. On a fresh clone it
records when git chose to write it, and git chooses an order — `codev/research/` can land before
`packages/`, making the evidence look older than a source it is perfectly current with. A guard
whose job is to be trusted must not fail for a reason unrelated to its subject.

claude suggested commit time. **Tried, and it breaks differently**, which is worth recording because
the failure is not obvious: a file written, run, and THEN committed always has a commit time later
than the run it produced — and that is the ordinary way this script is edited. The first attempt
went red on correct, current evidence.

So the evidence records **content hashes** of the sources it ran against, and the test recomputes
them. Neither side is a timestamp, so neither checkout order nor commit order can move it. It
answers what the guard means — is this evidence about the code that is here now — and it is the
mechanism `generated/source-hash.json` already uses for the contract.

`packages/t3-client/src/envelope.ts` is in the hashed set, which was the other half of claude's
iteration-1 point: the claim is that a *client* can read the discriminant, and that file is where
`RpcFailureError` decides what `error` and `tag` mean.

Verified by appending a line to `envelope.ts` and confirming the guard goes red, then restoring.
The live run was repeated so the recorded hashes describe the current sources.

## Recorded from the review, not disputed

claude checked the two `gateWriterTokenPath` call sites and found the asymmetry deliberate: the env
branch returns early and sources every field from env, because it exists to point a spawn at a
*different* server — and a different server's gate-writer token lives at a different path, so
falling back to the committed file there would be the defect rather than the fix.

## Not changed

Neither lane raised a blocking issue. All five phase 6 acceptance criteria are closed.

# Review rebuttal — iteration 1

Claude REQUEST_CHANGES HIGH. CI red on scenario 12. Accepted.

## Must-fix

- Scenario 12 no longer uses `git merge-base`. It asserts the working-tree source: one `/v2/` prefix, no `handleV2Route` in `tower-server.ts` / `pty-session.ts`.
- `parseScope` now splits the raw query on unencoded commas, then `decodeURIComponent` each segment. A path containing `%2C` stays one path.

## Not doing

- Delete the stub review file: porch greps `v2-server-events-push-based-st.md` for the Architecture/Lessons headings.
- Sampler lifecycle / scope eviction: already named as follow-ups.

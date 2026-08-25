## Structured gate request (optional)

After the phase's normal `porch done` step reports a human gate pending, record decision content
when it will help the architect rule without opening the worktree. Create a UTF-8 JSON file containing:

- one single-line `question`;
- one to five `choices`, each with a single-line `label` and `consequence`;
- `recommended: true` on at most one choice, when there is a recommendation; and
- optional `terminalExcerpt` with the last relevant output or warnings. CRLF becomes LF and ANSI
  formatting is removed; newlines and tabs are allowed, but remove spinner/progress returns that
  use a lone CR.

```json
{
  "question": "Delete the legacy table, or keep it for audit purposes?",
  "choices": [
    {
      "label": "Delete it",
      "consequence": "Migrate references, drop the table, run the full test suite, and open the PR.",
      "recommended": true
    },
    {
      "label": "Keep it",
      "consequence": "Retain the table and document the audit dependency."
    }
  ],
  "terminalExcerpt": "warning: legacy references remain\ncheckout tests failed"
}
```

Attach it to the current pending gate (relative paths resolve from the workspace root):

```bash
porch gate {{project_id}} --request-file gate-request.json
```

Structured content is optional. If it is not useful, the existing `porch gate {{project_id}}`
form remains valid. This records context only; it does not approve the gate. In either case, you
**must still send the existing architect notification with `afx send architect`** — the structured
record and the notification are separate requirements.

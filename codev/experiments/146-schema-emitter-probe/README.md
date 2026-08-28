# 146 — Effect JSON Schema emitter probe

Evidence for the Phase 1 design in `codev/plans/146-codev-client-on-t3code.md`. Answers the
question the architect deferred: can t3code's Effect schemas be turned into build-time artifacts
so `packages/types` keeps zero runtime dependencies?

Run with Node 22:

```bash
PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH
npm install && node representable.mjs && node lossy.mjs && node representation-blind.mjs
```

The schema definitions are copied verbatim from
`/Users/chris/dev/t3code/packages/contracts/src/baseSchemas.ts` at commit `082e6ea5`.

## What each script shows

**`representable.mjs`** — `SchemaRepresentation.toJsonSchemaDocument` handles every shape in the
vendoring closure: plain structs, unions, literals, brands, refinements, and both transform forms.
Nothing is unrepresentable. Codegen is viable.

**`lossy.mjs`** — but it is lossy, and predictably so. `Schema.String.check(isNonEmpty())` emits
`minLength: 1`. The *same check* on the decoded side of a `decodeTo` transform emits a bare
`{"type": "string"}`. `TrimmedNonEmptyString` is that shape, and it is the base of every branded
entity id in t3code (`ThreadId`, `ProjectId`, `CommandId`, `TurnId`, `MessageId`, …). So every id
in the generated schema is an unconstrained string. `ForwardCompatibleArray` degrades the same
way, to `{"type": "array"}` with no `items`.

**`representation-blind.mjs`** — and Effect's own `toRepresentation` is blind to it too. The
constrained and unconstrained forms serialise to the byte-identical document
`{"representation":{"_tag":"String","checks":[]},"references":{}}`.

## Why it changes the plan

A drift test built only on generated artifacts cannot see a change to any constraint behind a
transform. If t3code relaxed a branded id, not one emitted byte would move. Phase 1 therefore
carries two layers: a **source hash** over the 9 closure files as the load-bearing detector, and
the **generated diff** to name what changed when the emitter can express it.

The generated JSON Schema is a lower bound on t3code's validation, never an equivalent, which is
why the consumer in Phase 2 is called `shape-check` rather than `validate`.

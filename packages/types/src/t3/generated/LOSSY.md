# Lossy schemas

Generated. Every schema listed here has a JSON Schema **weaker** than the Effect schema it
came from, so `shape-check.ts` accepts input that t3code's server rejects.

**The divergence runs the other way too, and this file used to imply it did not.** The emitted
schema carries `additionalProperties: false` on many nodes, while t3code decodes with Effect's
default `onExcessProperty: "ignore"` — the server *strips* unknown keys. Read literally, the
schema is *stricter* there. `shapeCheck` ignores excess by default to mirror the decoder;
enforcing it would reject payloads the server sent, on exactly the additive changes the churn
classifier calls non-breaking.

This is not a bug to fix; it is a property of `toJsonSchemaDocument`, which drops checks
applied on the decoded side of a `decodeTo` transform. `TrimmedNonEmptyString` is exactly
that shape and it is the base of every branded id in t3code, so every id degrades to an
unconstrained string.

**Consequence for the drift test:** a change to any constraint listed here is invisible in
the generated output. `source-hash.json` is the layer that catches it. If the source hash
fires and the generated diff is empty, that is a real change with unknown effect on the
shapes we consume — not a false positive.

Each entry is a schema the source constrains (via `.check`, `Schema.brand` or `makeEntityId`)
whose emitted JSON Schema carries no constraint at all. Every field typed with one of these
degrades wherever it appears in `schema.json`.

### Source schemas whose constraints did not survive

- `TrimmedString` (`baseSchemas.ts`) → `{"type":"string"}` — transform not represented: decoding alters the value and the schema does not say so
- `TrimmedNonEmptyString` (`baseSchemas.ts`) → `{"type":"string"}`
- `ForwardCompatibleArray` (`baseSchemas.ts`) → `{"type":"array"}` — combinator: element type does not survive emission
- `ThreadId` (`baseSchemas.ts`) → `{"type":"string"}`
- `ProjectId` (`baseSchemas.ts`) → `{"type":"string"}`
- `EnvironmentId` (`baseSchemas.ts`) → `{"type":"string"}`
- `CommandId` (`baseSchemas.ts`) → `{"type":"string"}`
- `EventId` (`baseSchemas.ts`) → `{"type":"string"}`
- `MessageId` (`baseSchemas.ts`) → `{"type":"string"}`
- `TurnId` (`baseSchemas.ts`) → `{"type":"string"}`
- `AuthSessionId` (`baseSchemas.ts`) → `{"type":"string"}`
- `ProviderItemId` (`baseSchemas.ts`) → `{"type":"string"}`
- `RuntimeSessionId` (`baseSchemas.ts`) → `{"type":"string"}`
- `RuntimeItemId` (`baseSchemas.ts`) → `{"type":"string"}`
- `RuntimeRequestId` (`baseSchemas.ts`) → `{"type":"string"}`
- `RuntimeTaskId` (`baseSchemas.ts`) → `{"type":"string"}`
- `ApprovalRequestId` (`baseSchemas.ts`) → `{"type":"string"}`
- `CheckpointRef` (`baseSchemas.ts`) → `{"type":"string"}`
- `ProjectFaviconPath` (`orchestration.ts`) → `{"type":"string"}`
- `ProviderDriverKind` (`providerInstance.ts`) → `{"type":"string"}`
- `ProviderInstanceId` (`providerInstance.ts`) → `{"type":"string"}`
- `ProviderInstanceEnvironmentVariableName` (`providerInstance.ts`) → `{"type":"string"}`

### Positions in the emitted output with NO constraints at all

Found by scanning the generated schemas rather than the source symbols. The source scan walks
`export const` declarations and is therefore blind to a schema declared `const` —
`ModelSelectionSource` is one, and its fields land here. A `{}` accepts any value whatsoever,
which is a stronger loss than a bare typed schema.

- `OrchestrationEvent/anyOf/30/payload/activity/payload` → `{}` — no constraints at all: accepts any value
- `$defs/dispatchCommandInput__Objects_/provider/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/dispatchCommandInput__Objects_/instanceId/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/dispatchCommandInput__Objects_/model` → `{}` — no constraints at all: accepts any value
- `$defs/dispatchCommandInput__Objects_/options/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/subscribeThreadOutput__Objects_/provider/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/subscribeThreadOutput__Objects_/instanceId/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/subscribeThreadOutput__Objects_/model` → `{}` — no constraints at all: accepts any value
- `$defs/subscribeThreadOutput__Objects_/options/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/subscribeThreadOutput__Objects_5/payload` → `{}` — no constraints at all: accepts any value
- `$defs/OrchestrationEvent__Objects_2/provider/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/OrchestrationEvent__Objects_2/instanceId/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/OrchestrationEvent__Objects_2/model` → `{}` — no constraints at all: accepts any value
- `$defs/OrchestrationEvent__Objects_2/options/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/ClientOrchestrationCommand__Objects_/provider/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/ClientOrchestrationCommand__Objects_/instanceId/anyOf/0` → `{}` — no constraints at all: accepts any value
- `$defs/ClientOrchestrationCommand__Objects_/model` → `{}` — no constraints at all: accepts any value
- `$defs/ClientOrchestrationCommand__Objects_/options/anyOf/0` → `{}` — no constraints at all: accepts any value

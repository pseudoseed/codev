# Lossy schemas

Generated. Every schema listed here has a JSON Schema **weaker** than the Effect schema it
came from, so `shape-check.ts` accepts input that t3code's server rejects.

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

- `TrimmedString` (`baseSchemas.ts`) → `{"type":"string"}`
- `TrimmedNonEmptyString` (`baseSchemas.ts`) → `{"type":"string"}`
- `ForwardCompatibleArray` (`baseSchemas.ts`) → `{"type":"array"}`
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

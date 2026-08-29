import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SR from "effect/SchemaRepresentation";

// Verbatim from t3code packages/contracts/src/baseSchemas.ts
const TrimmedString = Schema.String.pipe(Schema.decodeTo(Schema.String,
  SchemaTransformation.transformOrFail({
    decode: (v) => Effect.succeed(v.trim()), encode: (v) => Effect.succeed(v.trim()) })));
const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());
const ForwardCompatibleArray = (element) => {
  const d = Schema.decodeUnknownOption(element);
  return Schema.Array(Schema.Unknown).pipe(Schema.decodeTo(Schema.Array(element),
    SchemaTransformation.transform({
      decode: (vs) => vs.filter((v) => Option.isSome(d(v))), encode: (vs) => vs })));
};
const makeEntityId = (b) => TrimmedNonEmptyString.pipe(Schema.brand(b));
const ThreadId = makeEntityId("ThreadId");
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ClientSurface = Schema.Literals(["web", "desktop", "mobile"]);

const cases = {
  TrimmedString, TrimmedNonEmptyString, ThreadId, NonNegativeInt, ClientSurface,
  ForwardCompatibleArray: ForwardCompatibleArray(ClientSurface),
  PlainStruct: Schema.Struct({ threadId: ThreadId, seq: NonNegativeInt,
                               surface: Schema.optionalKey(ClientSurface) }),
  Union: Schema.Union([Schema.Struct({ type: Schema.Literal("a"), x: ThreadId }),
                       Schema.Struct({ type: Schema.Literal("b"), y: NonNegativeInt })]),
};

for (const [name, s] of Object.entries(cases)) {
  try {
    const doc = SR.toJsonSchemaDocument(SR.toRepresentation(s.ast));
    console.log(`OK    ${name}  ${JSON.stringify(doc.schema ?? doc).slice(0,200)}`);
  } catch (e) { console.log(`FAIL  ${name}  ${String(e).split("\n")[0].slice(0,220)}`); }
}

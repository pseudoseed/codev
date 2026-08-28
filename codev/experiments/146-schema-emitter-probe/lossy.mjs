import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SR from "effect/SchemaRepresentation";
const TrimmedString = Schema.String.pipe(Schema.decodeTo(Schema.String,
  SchemaTransformation.transformOrFail({
    decode: (v) => Effect.succeed(v.trim()), encode: (v) => Effect.succeed(v.trim()) })));
const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());
const PlainNonEmpty = Schema.String.check(Schema.isNonEmpty());
const dump = (n,s)=>console.log(n, JSON.stringify(SR.toJsonSchemaDocument(SR.toRepresentation(s.ast)),null,1));
dump("PlainNonEmpty(no transform):", PlainNonEmpty);
dump("TrimmedNonEmptyString(transform):", TrimmedNonEmptyString);
// does the real decoder still reject ""?
console.log("effect decode '' via TrimmedNonEmptyString:",
  Effect.runSync(Effect.either(Schema.decodeUnknownEffect(TrimmedNonEmptyString)("")))._tag);

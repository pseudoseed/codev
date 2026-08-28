import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SR from "effect/SchemaRepresentation";
const T = Schema.String.pipe(Schema.decodeTo(Schema.String,
  SchemaTransformation.transformOrFail({ decode:(v)=>Effect.succeed(v.trim()), encode:(v)=>Effect.succeed(v.trim()) })));
const A = T.check(Schema.isNonEmpty());          // constrained
const B = T;                                      // unconstrained
const j = (s)=>JSON.stringify(SR.toJson(SR.toRepresentation(s.ast)));
console.log("repr(A):", j(A).slice(0,400));
console.log("repr(B):", j(B).slice(0,400));
console.log("REPRESENTATION DISTINGUISHES THEM:", j(A) !== j(B));

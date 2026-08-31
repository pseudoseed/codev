# Unrepresented schemas

Generated. Schemas the emitter could not represent at all. An entry here is more serious
than one in LOSSY.md: there is no JSON Schema for it, so `shape-check.ts` cannot check it
in any form.

**Scope:** this covers the 20 schemas Codev actually consumes plus every
schema reached by the loss scan — not literally every export in the closure. A schema nothing here
imports is never emitted, so it can be neither represented nor unrepresented. Claiming "every schema
in the closure was representable" would assert something this tool never tested.

_None of the 20 consumed schemas failed to emit._

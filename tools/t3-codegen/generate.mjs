#!/usr/bin/env node
/**
 * Spec 146 — t3code contract codegen.
 *
 * Emits, from a t3code checkout pinned by `packages/types/src/t3/pin.json`:
 *
 *   - `generated/schema.json`      JSON Schema for every schema we consume
 *   - `generated/types.d.ts`       self-contained TypeScript declarations
 *   - `generated/source-hash.json` sha256 per closure file
 *   - `generated/methods.json`     method -> {input, output} for the RPCs we call
 *   - `generated/LOSSY.md`         schemas whose JSON Schema is weaker than the source
 *   - `generated/UNREPRESENTED.md` schemas the emitter could not represent
 *   - `generated/ATTRIBUTION.md`   the MIT notice, which must travel with the artifacts
 *
 * WHY THE EMITTED SCHEMA IS NOT THE DRIFT DETECTOR
 * ------------------------------------------------
 * `SchemaRepresentation.toJsonSchemaDocument` silently drops checks applied on
 * the *decoded* side of a `decodeTo` transform. `Schema.String.check(isNonEmpty())`
 * emits `minLength: 1`; the same check behind a transform emits a bare
 * `{"type":"string"}`. `TrimmedNonEmptyString` is that shape, and it is the base
 * of every branded id in t3code (ThreadId, ProjectId, CommandId, TurnId, ...).
 * Effect's own `toRepresentation` is blind to it too — both forms serialise to
 * the identical document.
 *
 * So a relaxed branded id would move NOT ONE BYTE of the generated output. The
 * `source-hash.json` layer is therefore the load-bearing detector and the
 * generated diff is the explainer. If the two ever disagree, the hash wins.
 * See codev/experiments/146-schema-emitter-probe/ for the measurement.
 *
 * The closure is STAGED (copied) into `.staging/` rather than imported in place,
 * for three reasons: the pinned clone has no `node_modules` so `effect` would
 * not resolve from it; the staged copy is what gets hashed, so the hash covers
 * exactly what was read; and it keeps the tool from ever writing to the clone.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = join(repoRoot, 'packages', 'types', 'src', 't3', 'generated');
const pinPath = join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json');
const stagingDir = join(here, '.staging');

const checkOnly = process.argv.includes('--check');

/** Where the pinned t3code checkout lives. Overridable so CI can place it elsewhere. */
const t3Root = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';

function fail(message) {
  console.error(`[t3-codegen] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- pin + checkout

const pin = JSON.parse(readFileSync(pinPath, 'utf8'));

if (!existsSync(t3Root)) {
  fail(
    `No t3code checkout at ${t3Root}.\n` +
      `Set T3CODE_ROOT, or clone ${pin.repo} and check out ${pin.commit}.\n` +
      `This is a HARD FAILURE, not a skip: generating from a checkout that is not there\n` +
      `would silently emit nothing and read as success.`,
  );
}

let headSha;
try {
  headSha = execFileSync('git', ['-C', t3Root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch (error) {
  fail(`Could not read HEAD of ${t3Root}: ${error.message}`);
}

if (headSha !== pin.commit) {
  fail(
    `Checkout is at ${headSha} but pin.json says ${pin.commit}.\n` +
      `Generating against an unpinned tree would produce artifacts nobody can reproduce.\n` +
      `Either check out the pinned commit, or run the refresh procedure in REFRESH.md\n` +
      `to move the pin deliberately.`,
  );
}

// ---------------------------------------------------------------- stage the closure

const contractsSrc = join(t3Root, pin.contractsRoot);

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

for (const file of pin.closure) {
  const from = join(contractsSrc, file);
  if (!existsSync(from)) fail(`Closure file missing from the pinned checkout: ${file}`);
  cpSync(from, join(stagingDir, file));
}

/**
 * Guard against silent closure growth. If an upstream change makes a pinned file
 * import something outside the list, the vendoring surface grew and a human has
 * to decide whether to accept it — the tool must not decide by following.
 */
const importRe = /from\s+"\.\/([\w.]+\.ts)"/g;
const reached = new Set();
for (const file of pin.closure) {
  const src = readFileSync(join(stagingDir, file), 'utf8');
  for (const match of src.matchAll(importRe)) reached.add(match[1]);
}
const escaped = [...reached].filter((f) => !pin.closure.includes(f)).sort();
if (escaped.length > 0) {
  fail(
    `The pinned closure now reaches files outside pin.json: ${escaped.join(', ')}.\n` +
      `The vendoring surface grew. Decide deliberately whether to widen the closure —\n` +
      `do not just add them, since each one drags its own imports behind it.`,
  );
}

// ---------------------------------------------------------------- source hashes

const sourceHash = { commit: pin.commit, algorithm: 'sha256', files: {} };
for (const file of pin.closure.slice().sort()) {
  const bytes = readFileSync(join(stagingDir, file));
  sourceHash.files[file] = createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------- emit schemas

const SR = await import('effect/SchemaRepresentation');

/** Emit a JSON Schema document for one Effect schema, or record why we could not. */
function emit(schema) {
  const doc = SR.toJsonSchemaDocument(SR.toRepresentation(schema.ast));
  return doc.schema ?? doc;
}

/**
 * A schema is degraded when the source applies a check to it but the emitted
 * document carries no constraint at all — just a bare `{"type": ...}`.
 *
 * This is checked against the BASE schemas rather than the top-level payloads,
 * because that is where the loss originates: the payloads are structs, and a
 * struct emits fine while its `TrimmedNonEmptyString` fields quietly flatten to
 * unconstrained strings. Checking only the top level reports zero loss on a
 * contract that is losing a constraint on every id it carries.
 */
function isBare(jsonSchema) {
  return (
    jsonSchema && typeof jsonSchema === 'object' &&
    Object.keys(jsonSchema).length === 1 && typeof jsonSchema.type === 'string'
  );
}

/** Names exported by a staged file, in declaration order. */
function exportedConstNames(file) {
  const src = readFileSync(join(stagingDir, file), 'utf8');
  return [...src.matchAll(/^export const (\w+)\s*=/gm)].map((m) => m[1]);
}

/**
 * Does the source apply a check/brand to this schema? Both `.check(...)` and
 * `Schema.brand(...)` sit on the decoded side of the transforms in question, so
 * both are constraints the emitter can lose.
 */
function sourceConstrains(file, name) {
  const src = readFileSync(join(stagingDir, file), 'utf8');
  const re = new RegExp(`export const ${name}\\s*=([\\s\\S]*?);\\n`, 'm');
  const body = re.exec(src)?.[1] ?? '';
  return /\.check\(|Schema\.brand\(|makeEntityId\(/.test(body);
}

const orchestration = await import(pathToFileURL(join(stagingDir, 'orchestration.ts')).href);
const git = await import(pathToFileURL(join(stagingDir, 'git.ts')).href);

const schemas = {};
const lossy = [];
const unrepresented = [];
const methods = {};

function record(name, schema) {
  if (name in schemas) return;
  try {
    schemas[name] = emit(schema);
  } catch (error) {
    unrepresented.push({ name, reason: String(error).split('\n')[0] });
  }
}

/**
 * Scan every base schema in the closure for the degradation described in the
 * file header. Runs before the payloads are recorded so LOSSY.md reflects the
 * primitives, which is where a reader needs to look.
 */
async function scanForLoss() {
  // A concrete element schema to probe combinators with. baseSchemas is the
  // right source: it is the closure's own root and has no further imports.
  const orchestrationBase = await import(pathToFileURL(join(stagingDir, 'baseSchemas.ts')).href);

  for (const file of pin.closure) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(stagingDir, file)).href);
    } catch {
      continue; // a file that will not load on its own is not a loss signal
    }
    for (const name of exportedConstNames(file)) {
      const candidate = mod[name];
      if (candidate == null) continue;

      // Effect 4 schemas are callable, so `typeof` is 'function', not 'object'.
      // Guarding on 'object' silently skips every schema and reports zero loss.
      const isSchema =
        (typeof candidate === 'object' || typeof candidate === 'function') && candidate.ast !== undefined;

      if (isSchema) {
        if (!sourceConstrains(file, name)) continue;
        let emitted;
        try {
          emitted = emit(candidate);
        } catch {
          continue; // recorded as unrepresented if we actually consume it
        }
        if (isBare(emitted)) lossy.push({ file, name, emitted: JSON.stringify(emitted) });
        continue;
      }

      // Schema COMBINATORS — a plain function returning a schema, e.g.
      // `ForwardCompatibleArray`. These have no `.ast` of their own, so the
      // branch above skips them, and they are exactly where the second known
      // loss lives: a filtering `decodeTo` transform whose element type does not
      // survive emission. Probe by applying the combinator to a known element and
      // checking whether that element's shape shows up in the output.
      if (typeof candidate === 'function' && candidate.length >= 1) {
        try {
          const probeElement = orchestrationBase.ClientSurface ?? null;
          if (!probeElement) continue;
          const applied = candidate(probeElement);
          if (!applied || applied.ast === undefined) continue;
          const emitted = emit(applied);
          // An array whose `items` vanished has lost its element constraint
          // entirely: `{"type":"array"}` accepts an array of anything.
          if (emitted && emitted.type === 'array' && emitted.items === undefined) {
            lossy.push({
              file,
              name,
              emitted: JSON.stringify(emitted),
              note: 'combinator: element type does not survive emission',
            });
          }
        } catch {
          // Not a schema combinator, or needs arguments we cannot synthesise.
          continue;
        }
      }
    }
  }
}

await scanForLoss();

// Orchestration methods come from the contract's own machine-readable map, so a
// method added or renamed upstream shows up here rather than in a hand-edit.
const rpcMap = orchestration.OrchestrationRpcSchemas;
for (const [method, spec] of Object.entries(pin.methods)) {
  if (method.startsWith('_')) continue;
  if (spec.source === 'OrchestrationRpcSchemas') {
    const entry = rpcMap?.[spec.key];
    if (!entry) fail(`pin.json names ${method} (key ${spec.key}) but OrchestrationRpcSchemas has no such entry.`);
    const inName = `${spec.key}Input`;
    const outName = `${spec.key}Output`;
    record(inName, entry.input);
    record(outName, entry.output);
    methods[method] = { input: inName, output: outName, stream: Boolean(spec.stream) };
  } else {
    const inSchema = spec.input ? git[spec.input] : null;
    if (spec.input && !inSchema) fail(`pin.json names ${spec.input} for ${method}, but git.ts does not export it.`);
    if (inSchema) record(spec.input, inSchema);
    const outSchema = spec.output ? git[spec.output] : null;
    if (spec.output && !outSchema) fail(`pin.json names ${spec.output} for ${method}, but git.ts does not export it.`);
    if (outSchema) record(spec.output, outSchema);
    methods[method] = { input: spec.input ?? null, output: spec.output ?? null, stream: false };
  }
}

// The event union is not an RPC payload but every consumer decodes it.
for (const name of ['OrchestrationEvent', 'ClientOrchestrationCommand']) {
  if (orchestration[name]) record(name, orchestration[name]);
}

// ---------------------------------------------------------------- JSON Schema -> .d.ts
//
// Types are derived from the emitted JSON Schema rather than from the Effect
// source, so the declarations carry no reference to `effect` and
// `packages/types` keeps zero dependencies of any kind.

function tsTypeFor(node, indent = 0) {
  const pad = '  '.repeat(indent);
  if (!node || typeof node !== 'object') return 'unknown';
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(node.anyOf)) return node.anyOf.map((n) => tsTypeFor(n, indent)).join(' | ');
  if (Array.isArray(node.oneOf)) return node.oneOf.map((n) => tsTypeFor(n, indent)).join(' | ');
  switch (node.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return node.items ? `ReadonlyArray<${tsTypeFor(node.items, indent)}>` : 'ReadonlyArray<unknown>';
    case 'object': {
      const props = node.properties ?? {};
      const names = Object.keys(props);
      if (names.length === 0) return 'Record<string, unknown>';
      const required = new Set(node.required ?? []);
      const lines = names.map((key) => {
        const opt = required.has(key) ? '' : '?';
        return `${pad}  readonly ${JSON.stringify(key)}${opt}: ${tsTypeFor(props[key], indent + 1)};`;
      });
      return `{\n${lines.join('\n')}\n${pad}}`;
    }
    default: return 'unknown';
  }
}

const dtsLines = [
  '// GENERATED by tools/t3-codegen — do not edit.',
  `// Source: ${pin.repo} @ ${pin.commit}`,
  '//',
  '// Derived from the emitted JSON Schema, not from the Effect source, so these',
  '// declarations reference no runtime library and `packages/types` keeps zero',
  '// dependencies. See generated/LOSSY.md: some constraints present in t3code are',
  '// NOT expressible here, so these types are a lower bound on what the server accepts.',
  '',
];
for (const [name, schema] of Object.entries(schemas)) {
  dtsLines.push(`export type ${name} = ${tsTypeFor(schema)};`, '');
}
dtsLines.push('export interface T3Method { readonly input: string | null; readonly output: string | null; readonly stream: boolean; }');
dtsLines.push(`export type T3MethodName = ${Object.keys(methods).map((m) => JSON.stringify(m)).join(' | ')};`, '');

// ---------------------------------------------------------------- reports

const attribution = `# Attribution

The files in this directory are **generated from t3code**, which is MIT licensed.

- Source: ${pin.repo}
- Commit: \`${pin.commit}\` (${pin.commitDate})
- Generated by: \`tools/t3-codegen/generate.mjs\`

\`@cluesmith/codev-types\` is published under Apache-2.0 and ships \`files: ["src", "dist"]\`,
so these derived artifacts leave this repository inside a distributed package. MIT requires
its notice to travel with the distribution, which is why this file sits beside them rather
than in a place a packaging step might drop.

\`\`\`
MIT License

Copyright (c) t3code contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`
`;

const lossyDoc = `# Lossy schemas

Generated. Every schema listed here has a JSON Schema **weaker** than the Effect schema it
came from, so \`shape-check.ts\` accepts input that t3code's server rejects.

This is not a bug to fix; it is a property of \`toJsonSchemaDocument\`, which drops checks
applied on the decoded side of a \`decodeTo\` transform. \`TrimmedNonEmptyString\` is exactly
that shape and it is the base of every branded id in t3code, so every id degrades to an
unconstrained string.

**Consequence for the drift test:** a change to any constraint listed here is invisible in
the generated output. \`source-hash.json\` is the layer that catches it. If the source hash
fires and the generated diff is empty, that is a real change with unknown effect on the
shapes we consume — not a false positive.

Each entry is a schema the source constrains (via \`.check\`, \`Schema.brand\` or \`makeEntityId\`)
whose emitted JSON Schema carries no constraint at all. Every field typed with one of these
degrades wherever it appears in \`schema.json\`.

${
  lossy.length === 0
    ? '_None detected. If this section is empty, be suspicious: the probe in ' +
      'codev/experiments/146-schema-emitter-probe/ demonstrates the loss exists._'
    : lossy.map((l) => `- \`${l.name}\` (\`${l.file}\`) → \`${l.emitted}\``).join('\n')
}
`;

const unrepDoc = `# Unrepresented schemas

Generated. Schemas the emitter could not represent at all. An entry here is more serious
than one in LOSSY.md: there is no JSON Schema for it, so \`shape-check.ts\` cannot check it
in any form.

${unrepresented.length === 0 ? '_None. Every schema in the closure was representable._' : unrepresented.map((u) => `- \`${u.name}\` — ${u.reason}`).join('\n')}
`;

// ---------------------------------------------------------------- write / check

// `schema.json` is the diffable artifact; `schema.ts` is what actually ships.
// Emitting a TS module avoids `resolveJsonModule` and the matching "copy the
// JSON into dist" build step, which is the kind of thing that passes in CI and
// then fails at a consumer's runtime because the file never reached `dist`.
const schemaModule =
  '// GENERATED by tools/t3-codegen — do not edit.\n' +
  `// Source: ${pin.repo} @ ${pin.commit}\n` +
  '//\n' +
  '// A LOWER BOUND on t3code\'s validation, not an equivalent. See LOSSY.md.\n\n' +
  'export const t3Schemas = ' +
  JSON.stringify(schemas, null, 2) +
  ' as const;\n\n' +
  'export const t3Methods = ' +
  JSON.stringify(methods, null, 2) +
  ' as const;\n';

const artifacts = {
  'schema.ts': schemaModule,
  'schema.json': JSON.stringify(schemas, null, 2) + '\n',
  'source-hash.json': JSON.stringify(sourceHash, null, 2) + '\n',
  'methods.json': JSON.stringify(methods, null, 2) + '\n',
  'types.d.ts': dtsLines.join('\n'),
  'LOSSY.md': lossyDoc,
  'UNREPRESENTED.md': unrepDoc,
  'ATTRIBUTION.md': attribution,
};

mkdirSync(outDir, { recursive: true });

let drifted = [];
for (const [name, content] of Object.entries(artifacts)) {
  const path = join(outDir, name);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing !== content) drifted.push(name);
  if (!checkOnly) writeFileSync(path, content);
}

rmSync(stagingDir, { recursive: true, force: true });

if (checkOnly) {
  if (drifted.length > 0) {
    const hashMoved = drifted.includes('source-hash.json');
    const shapesMoved = drifted.includes('schema.json') || drifted.includes('schema.ts');

    // The three outcomes are deliberately not collapsed into two. A source-hash
    // change with an unchanged schema is the case the whole two-layer design
    // exists for: the emitter is blind to constraints behind a transform, so
    // "no schema diff" is NOT "no effect" — it is "effect unknown". Reporting
    // that as a pass, or as an ordinary staleness, is the failure this guards.
    if (hashMoved && !shapesMoved) {
      fail(
        `UPSTREAM CHANGED; EFFECT ON CONSUMED SHAPES UNKNOWN.\n` +
          `  source-hash.json moved: the pinned contract source is not what it was.\n` +
          `  schema.json did not: the emitter sees no difference.\n\n` +
          `This is NOT a false positive and NOT a formatting nit. All 20 schemas in\n` +
          `generated/LOSSY.md — every branded id in the contract — emit unconstrained, so a\n` +
          `relaxed constraint lands exactly here with a zero-byte schema diff.\n` +
          `Read the source diff before regenerating. Stale artifacts: ${drifted.join(', ')}`,
      );
    }
    fail(
      `Generated artifacts are stale: ${drifted.join(', ')}.\n` +
        (shapesMoved
          ? `A shape Codev consumes changed — diff schema.json to see what.\n`
          : '') +
        `Run \`pnpm --filter @cluesmith/t3-codegen generate\`.`,
    );
  }
  console.log('[t3-codegen] artifacts are up to date');
} else {
  console.log(
    `[t3-codegen] wrote ${Object.keys(artifacts).length} artifacts: ` +
      `${Object.keys(schemas).length} schemas, ${Object.keys(methods).length} methods, ` +
      `${lossy.length} lossy, ${unrepresented.length} unrepresented`,
  );
}

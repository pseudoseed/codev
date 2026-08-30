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
 *
 * WHICH CHECKOUT THIS GENERATES FROM (spec 250)
 * ---------------------------------------------
 * The FORK. `pin.commit` keeps its meaning — the commit the artifacts came from —
 * and from phase 5 that commit lives only in the private customization checkout.
 * Generating from the upstream clone while asserting `HEAD === pin.commit` would
 * be unsatisfiable the moment the fork diverges, so the root moves with the
 * commit rather than the assertion being loosened.
 *
 * `source-hash.json` therefore records TWO sections. `files` is the fork closure,
 * as before, and `upstream` is the same closure hashed at `upstreamBase` from the
 * upstream clone. Without the second section, "the generated artifacts match the
 * source they were generated from" is a tautology: it compares the fork to
 * itself. With it, the fork's divergence from upstream is a fact on disk that a
 * test can read.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { resolveIdentities } from '../t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = join(repoRoot, 'packages', 'types', 'src', 't3', 'generated');
const pinPath = join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json');
const stagingDir = join(here, '.staging');

const checkOnly = process.argv.includes('--check');

function fail(message) {
  console.error(`[t3-codegen] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- pin + checkouts

const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
const { upstream, fork } = resolveIdentities(pin);

/**
 * The checkout generation reads. It is the FORK, because `pin.commit` is the fork
 * head; `T3CODE_FORK_ROOT` overrides it so CI can place it elsewhere.
 */
const t3Root = fork.root;

if (!existsSync(t3Root)) {
  fail(
    `No fork checkout at ${t3Root}.\n` +
      `Set ${fork.rootVar}, or clone ${fork.repo ?? 'the private fork'} and check out ${pin.commit}.\n` +
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
    `Fork checkout is at ${headSha} but pin.json says ${pin.commit}.\n` +
      `Generating against an unpinned tree would produce artifacts nobody can reproduce.\n` +
      `Either check out the pinned commit, or run the refresh procedure in REFRESH.md\n` +
      `to move the pin deliberately.`,
  );
}

/**
 * The upstream clone, read only to hash the same closure at `upstreamBase`.
 *
 * Its absence does not fail generation: the fork is what the artifacts come from,
 * and refusing to generate because a second, purely comparative checkout is
 * missing would make a reference measurement a build dependency. It is recorded
 * as `available: false` instead, which is spelled differently from "the hashes
 * matched".
 */
const upstreamRoot = upstream.root;
let upstreamHead = null;
if (existsSync(upstreamRoot)) {
  try {
    upstreamHead = execFileSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    upstreamHead = null;
  }
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

/**
 * The upstream closure at `upstreamBase`, hashed from the upstream clone.
 *
 * `files` above is the fork, and a hash of the fork checked against artifacts
 * generated from the fork proves only that the generator is deterministic. This
 * section is the other end of the comparison: it says what upstream's bytes were
 * at the base we branched from, so fork drift is a subtraction rather than a
 * claim. `available: false` when the upstream clone is absent or its HEAD has
 * moved off the base — an unmeasured section must not read as a measured match.
 */
sourceHash.upstream = { commit: upstream.commit, available: false, files: {} };
if (upstreamHead === null) {
  sourceHash.upstream.reason = `no readable upstream checkout at ${upstreamRoot}`;
} else if (upstreamHead !== upstream.commit) {
  sourceHash.upstream.reason =
    `${upstreamRoot} is at ${upstreamHead}, not upstreamBase ${upstream.commit}; ` +
    'hashing it would record the wrong tree under the right name';
} else {
  const upstreamContracts = join(upstreamRoot, pin.contractsRoot);
  const missing = pin.closure.filter((file) => !existsSync(join(upstreamContracts, file)));
  if (missing.length > 0) {
    sourceHash.upstream.reason = `closure files absent from the upstream checkout: ${missing.join(', ')}`;
  } else {
    for (const file of pin.closure.slice().sort()) {
      const bytes = readFileSync(join(upstreamContracts, file));
      sourceHash.upstream.files[file] = createHash('sha256').update(bytes).digest('hex');
    }
    sourceHash.upstream.available = true;
  }
}

/** How many closure files the fork has actually changed. Zero until phase 5. */
sourceHash.forkDrift = sourceHash.upstream.available
  ? {
    measured: true,
    changedFiles: pin.closure
      .slice()
      .sort()
      .filter((file) => sourceHash.files[file] !== sourceHash.upstream.files[file]),
  }
  : { measured: false, reason: sourceHash.upstream.reason };

// ---------------------------------------------------------------- emit schemas

const SR = await import('effect/SchemaRepresentation');

/**
 * Emit the JSON Schema for one Effect schema.
 *
 * Returns only the root. Callers that keep the result MUST go through
 * `emitWithDefs`, because a document's `$defs` are not optional decoration: the
 * root is full of `$ref`s into them. An earlier version of this file returned
 * `doc.schema ?? doc` and discarded `doc.$defs` — which produced 105 dangling
 * `$ref`s, made `shapeCheck` return `matches: true` at every one of them, and
 * turned 111 positions in `types.d.ts` into `unknown`. Three reviewers caught it
 * independently. Use this only where the root alone is the question, as in the
 * loss scan on primitive schemas.
 */
function emit(schema) {
  const doc = SR.toJsonSchemaDocument(SR.toRepresentation(schema.ast));
  return doc.schema ?? doc;
}

/** Emit root plus definitions, namespaced so two schemas cannot collide. */
function emitWithDefs(schema, namespace) {
  const doc = SR.toJsonSchemaDocument(SR.toRepresentation(schema.ast));
  const root = doc.schema ?? doc;
  const defs = doc.$defs ?? doc.definitions ?? {};

  // `toJsonSchemaDocument` names definitions per-document (`Objects_1`, ...), so
  // merging several documents into one file would alias unrelated shapes onto the
  // same key. Namespace by the schema we are emitting.
  const rename = (name) => `${namespace}__${name}`;
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(value);
        out[key] = match ? `#/$defs/${rename(match[1])}` : value;
      } else {
        out[key] = rewrite(value);
      }
    }
    return out;
  };

  const namespacedDefs = {};
  for (const [name, value] of Object.entries(defs)) namespacedDefs[rename(name)] = rewrite(value);
  return { root: rewrite(root), defs: namespacedDefs };
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
function sourceTransforms(file, name) {
  const src = readFileSync(join(stagingDir, file), 'utf8');
  const re = new RegExp(`export const ${name}\\s*=([\\s\\S]*?);\\n`, 'm');
  const body = re.exec(src)?.[1] ?? '';
  return /Schema\.decodeTo\(/.test(body);
}

function sourceConstrains(file, name) {
  const src = readFileSync(join(stagingDir, file), 'utf8');
  const re = new RegExp(`export const ${name}\\s*=([\\s\\S]*?);\\n`, 'm');
  const body = re.exec(src)?.[1] ?? '';
  return /\.check\(|Schema\.brand\(|makeEntityId\(/.test(body);
}

const orchestration = await import(pathToFileURL(join(stagingDir, 'orchestration.ts')).href);
const git = await import(pathToFileURL(join(stagingDir, 'git.ts')).href);

const schemas = {};
/** Shared `$defs` pool. Every `$ref` in `schemas` resolves into this. */
const allDefs = {};
const lossy = [];
const unrepresented = [];
const methods = {};

function record(name, schema) {
  if (name in schemas) return;
  try {
    const { root, defs } = emitWithDefs(schema, name);
    schemas[name] = root;
    Object.assign(allDefs, defs);
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
        // A `decodeTo` transform with NO check still loses something: the emitted
        // schema records nothing about the decoding. `TrimmedString` is that case —
        // it trims, and `{"type":"string"}` does not say so, so a consumer cannot
        // tell that " x " and "x" are the same value to the server. The plan names
        // it among the three hardest cases, so it is reported rather than skipped
        // for lacking a `.check(`.
        if (!sourceConstrains(file, name) && sourceTransforms(file, name)) {
          try {
            const emitted = emit(candidate);
            if (isBare(emitted)) {
              lossy.push({
                file, name, emitted: JSON.stringify(emitted),
                note: 'transform not represented: decoding alters the value and the schema does not say so',
              });
            }
          } catch { /* unrepresented is recorded elsewhere */ }
          continue;
        }
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

/**
 * Scan the EMITTED OUTPUT for loss, not just the source symbols.
 *
 * The source scan has a structural blind spot review found: it walks
 * `export const` declarations, so a schema declared `const` with no export is
 * invisible to it. `ModelSelectionSource` is exactly that, and its fields emit as
 * bare `{}` — a schema with no constraints at all, which accepts literally any
 * value. That is a stronger loss than `{"type":"string"}` and it was missing from
 * LOSSY.md entirely.
 *
 * Scanning the output catches loss wherever it originates, including from symbols
 * the source scan cannot name.
 */
function scanEmittedForLoss() {
  const found = [];
  const walk = (node, path, root) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}/${i}`, root));
      return;
    }
    const keys = Object.keys(node);
    if (keys.length === 0) {
      found.push({ root, path: path || '/', emitted: '{}', why: 'no constraints at all: accepts any value' });
      return;
    }
    if (keys.length === 1 && keys[0] === '$ref') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const [prop, sub] of Object.entries(v)) walk(sub, `${path}/${prop}`, root);
      } else if (['items', 'anyOf', 'oneOf', 'allOf'].includes(k)) {
        walk(v, `${path}/${k}`, root);
      }
    }
  };
  for (const [name, schema] of Object.entries(schemas)) walk(schema, '', name);
  for (const [name, def] of Object.entries(allDefs)) walk(def, '', `$defs/${name}`);
  return found;
}

const emittedLoss = scanEmittedForLoss();

// ---------------------------------------------------------------- JSON Schema -> .d.ts
//
// Types are derived from the emitted JSON Schema rather than from the Effect
// source, so the declarations carry no reference to `effect` and
// `packages/types` keeps zero dependencies of any kind.

function tsTypeFor(node, indent = 0, seen = new Set()) {
  const pad = '  '.repeat(indent);
  if (!node || typeof node !== 'object') return 'unknown';

  // Resolve $refs against the shared pool. Falling through to `unknown` here is
  // what turned 111 positions of this file into `unknown` before definitions were
  // carried; a cycle guard keeps a self-referential schema from recursing forever.
  if (typeof node.$ref === 'string') {
    const key = /^#\/\$defs\/(.+)$/.exec(node.$ref)?.[1];
    if (!key) return 'unknown';
    if (seen.has(key)) return 'unknown';
    const target = allDefs[key];
    if (!target) return 'unknown';
    return tsTypeFor(target, indent, new Set([...seen, key]));
  }
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(node.anyOf)) return node.anyOf.map((n) => tsTypeFor(n, indent, seen)).join(' | ');
  if (Array.isArray(node.oneOf)) return node.oneOf.map((n) => tsTypeFor(n, indent, seen)).join(' | ');
  switch (node.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return node.items ? `ReadonlyArray<${tsTypeFor(node.items, indent, seen)}>` : 'ReadonlyArray<unknown>';
    case 'object': {
      const props = node.properties ?? {};
      const names = Object.keys(props);
      if (names.length === 0) return 'Record<string, unknown>';
      const required = new Set(node.required ?? []);
      const lines = names.map((key) => {
        const opt = required.has(key) ? '' : '?';
        return `${pad}  readonly ${JSON.stringify(key)}${opt}: ${tsTypeFor(props[key], indent + 1, seen)};`;
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

// The upstream notice is read from the pinned checkout and reproduced VERBATIM.
// An earlier version paraphrased the copyright line as "t3code contributors";
// upstream actually says "Copyright (c) 2026 T3 Tools Inc." MIT requires the
// notice, not a summary of it, so it is never hand-written here.
const licensePath = join(t3Root, 'LICENSE');
if (!existsSync(licensePath)) {
  fail(
    `No LICENSE at ${licensePath}. These artifacts are derived from MIT-licensed source and\n` +
      `ship inside a published package; the notice must travel with them. Refusing to emit\n` +
      `attribution invented from memory.`,
  );
}
const upstreamLicense = readFileSync(licensePath, 'utf8').trimEnd();

const attribution = `# Attribution

The files in this directory are **generated from t3code**, which is MIT licensed.

- Source: ${pin.repo}
- Commit: \`${pin.commit}\` (${pin.commitDate})
- Generated by: \`tools/t3-codegen/generate.mjs\`

\`@cluesmith/codev-types\` is published under Apache-2.0 and ships \`files: ["src", "dist"]\`,
so these derived artifacts leave this repository inside a distributed package. MIT requires
its notice to travel with the distribution, which is why this file sits beside them rather
than in a place a packaging step might drop.

The notice below is reproduced verbatim from \`LICENSE\` at the pinned commit.

\`\`\`
${upstreamLicense}
\`\`\`
`;

const lossyDoc = `# Lossy schemas

Generated. Every schema listed here has a JSON Schema **weaker** than the Effect schema it
came from, so \`shape-check.ts\` accepts input that t3code's server rejects.

**The divergence runs the other way too, and this file used to imply it did not.** The emitted
schema carries \`additionalProperties: false\` on many nodes, while t3code decodes with Effect's
default \`onExcessProperty: "ignore"\` — the server *strips* unknown keys. Read literally, the
schema is *stricter* there. \`shapeCheck\` ignores excess by default to mirror the decoder;
enforcing it would reject payloads the server sent, on exactly the additive changes the churn
classifier calls non-breaking.

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

### Source schemas whose constraints did not survive

${
  lossy.length === 0
    ? '_None detected. If this section is empty, be suspicious: the probe in ' +
      'codev/experiments/146-schema-emitter-probe/ demonstrates the loss exists._'
    : lossy.map((l) => `- \`${l.name}\` (\`${l.file}\`) \u2192 \`${l.emitted}\`${l.note ? ` \u2014 ${l.note}` : ''}`).join('\n')
}

### Positions in the emitted output with NO constraints at all

Found by scanning the generated schemas rather than the source symbols. The source scan walks
\`export const\` declarations and is therefore blind to a schema declared \`const\` \u2014
\`ModelSelectionSource\` is one, and its fields land here. A \`{}\` accepts any value whatsoever,
which is a stronger loss than a bare typed schema.

${
  emittedLoss.length === 0
    ? '_None._'
    : emittedLoss.map((l) => `- \`${l.root}${l.path}\` \u2192 \`${l.emitted}\` \u2014 ${l.why}`).join('\n')
}
`;

const unrepDoc = `# Unrepresented schemas

Generated. Schemas the emitter could not represent at all. An entry here is more serious
than one in LOSSY.md: there is no JSON Schema for it, so \`shape-check.ts\` cannot check it
in any form.

**Scope:** this covers the ${Object.keys(schemas).length} schemas Codev actually consumes plus every
schema reached by the loss scan — not literally every export in the closure. A schema nothing here
imports is never emitted, so it can be neither represented nor unrepresented. Claiming "every schema
in the closure was representable" would assert something this tool never tested.

${unrepresented.length === 0 ? `_None of the ${Object.keys(schemas).length} consumed schemas failed to emit._` : unrepresented.map((u) => `- \`${u.name}\` — ${u.reason}`).join('\n')}
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
  'export const t3Defs = ' +
  JSON.stringify(allDefs, null, 2) +
  ' as const;\n\n' +
  'export const t3Schemas = ' +
  JSON.stringify(schemas, null, 2) +
  ' as const;\n\n' +
  'export const t3Methods = ' +
  JSON.stringify(methods, null, 2) +
  ' as const;\n';

// A guard, not a formality: if any `$ref` in the emitted schemas points at a
// definition we did not carry, `shapeCheck` would pass anything at that position.
// That defect shipped once; it does not ship twice.
const refRe = /"\$ref":\s*"#\/\$defs\/([^"]+)"/g;
const dangling = new Set();
for (const match of JSON.stringify(schemas).matchAll(refRe)) {
  if (!(match[1] in allDefs)) dangling.add(match[1]);
}
if (dangling.size > 0) {
  fail(
    `${dangling.size} dangling $ref(s) with no definition: ${[...dangling].slice(0, 5).join(', ')}.\n` +
      `shapeCheck would silently report a match at every one of them.`,
  );
}

const document = { $defs: allDefs, schemas };

const artifacts = {
  'schema.ts': schemaModule,
  'schema.json': JSON.stringify(document, null, 2) + '\n',
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
          `This is NOT a false positive and NOT a formatting nit. All ${lossy.length} schemas in\n` +
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
      `${lossy.length} lossy, ${emittedLoss.length} unconstrained, ${unrepresented.length} unrepresented`,
  );
}

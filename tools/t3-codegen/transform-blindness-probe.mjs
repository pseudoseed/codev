#!/usr/bin/env node
/**
 * Spec 146, Phase 1 — the regression probe that proves the source-hash layer
 * earns its place.
 *
 * The plan's acceptance criterion: take `TrimmedNonEmptyString`, remove its
 * `isNonEmpty` check, regenerate, and assert the **source-hash layer fails while
 * the generated diff stays empty**. If a drift test passes here, it is not
 * detecting drift.
 *
 * This runs without a scratch t3code checkout: it mutates a staged copy of
 * `baseSchemas.ts` in memory, emits both versions, and compares. Requiring a
 * second checkout would have made the check something nobody runs.
 *
 * Emits JSON so the vitest suite can assert on it without importing `effect`,
 * which must never enter `packages/codev`'s dependency graph.
 *
 * Usage: node transform-blindness-probe.mjs
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveIdentities } from '../t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'));

// Spec 250: the FORK identity. This probe asks whether the drift layers would
// catch a relaxed check in the source WE GENERATE FROM, and from phase 5 that
// source is the fork. Probing upstream would measure a tree the artifacts no
// longer come from, and report the answer as if it were about ours.
const { fork } = resolveIdentities(pin);
const t3Root = fork.root;
const basePath = join(t3Root, pin.contractsRoot, 'baseSchemas.ts');

const SR = await import('effect/SchemaRepresentation');

const original = readFileSync(basePath, 'utf8');

// The mutation: drop the non-empty check from the schema every branded id is
// built on. Upstream could make exactly this change in a refactor.
const CHECKED = 'export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());';
const RELAXED = 'export const TrimmedNonEmptyString = TrimmedString;';

if (!original.includes(CHECKED)) {
  console.log(JSON.stringify({
    ok: false,
    reason:
      'baseSchemas.ts no longer declares TrimmedNonEmptyString the way this probe expects. ' +
      'The probe is stale — re-derive it before trusting either drift layer.',
  }, null, 2));
  process.exit(2);
}

const mutated = original.replace(CHECKED, RELAXED);

/** Emit the branded-id schema from one version of the source. */
async function emitFrom(contents, tag) {
  const dir = mkdtempSync(join(here, '.probe-'));
  try {
    writeFileSync(join(dir, 'baseSchemas.ts'), contents);
    const mod = await import(`${pathToFileURL(join(dir, 'baseSchemas.ts')).href}?t=${tag}`);
    const out = {};
    for (const name of ['TrimmedNonEmptyString', 'ThreadId', 'CommandId']) {
      const schema = mod[name];
      const doc = SR.toJsonSchemaDocument(SR.toRepresentation(schema.ast));
      out[name] = JSON.stringify(doc.schema ?? doc);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const before = await emitFrom(original, 'orig');
const after = await emitFrom(mutated, 'relaxed');

const hashBefore = createHash('sha256').update(original).digest('hex');
const hashAfter = createHash('sha256').update(mutated).digest('hex');

const schemaChanged = JSON.stringify(before) !== JSON.stringify(after);
const hashChanged = hashBefore !== hashAfter;

console.log(JSON.stringify({
  ok: true,
  mutation: 'removed isNonEmpty() from TrimmedNonEmptyString',
  emittedBefore: before,
  emittedAfter: after,
  // The whole point. The generated layer sees nothing; the hash layer sees it.
  schemaChanged,
  hashChanged,
  verdict:
    !schemaChanged && hashChanged
      ? 'CONFIRMED: the generated layer is blind to this change; only the source hash catches it.'
      : schemaChanged
        ? 'The emitter now represents this constraint. The second layer may be reconsiderable — do that deliberately, with a human.'
        : 'Neither layer detected the change. Both drift layers are broken.',
}, null, 2));

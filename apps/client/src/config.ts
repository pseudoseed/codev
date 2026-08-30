import type { MachineConfig } from './connection/machine.js';

/**
 * What an `id` may be, and why it is constrained rather than trusted.
 *
 * The id is not a label. It keys connection state, the human session for that
 * machine, React's reconciliation, the approval lookup, and the `/m/<id>/` path
 * every request travels. A `..`, a `/` or an empty string would each break a
 * different one of those, and the proxy path is the one that breaks quietly.
 */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function isMachine(value: unknown): value is MachineConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && ID.test(record.id)
    && typeof record.label === 'string'
    && record.label.length > 0
    && typeof record.origin === 'string'
    && record.origin.length > 0
    && typeof record.workspacePath === 'string'
    && record.workspacePath.length > 0
    && typeof record.credential === 'string'
    && record.credential.length > 0;
}

export type MachineConfigLoad =
  | { readonly ok: true; readonly machines: readonly MachineConfig[]; readonly dropped: number }
  | { readonly ok: false; readonly message: string };

/**
 * The machines this client talks to, read from a same-origin JSON document.
 *
 * A malformed entry is DROPPED AND COUNTED rather than half-adopted: a machine
 * row with no credential would render as permanently disconnected and blame the
 * server for a configuration mistake. A configuration document that cannot be
 * read at all is its own outcome — "we could not tell what to connect to" is not
 * "there is nothing to connect to".
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadMachines(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  url = 'machines.json',
): Promise<MachineConfigLoad> {
  let parsed: unknown;
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return { ok: false, message: `machine configuration could not be read (HTTP ${response.status})` };
    }
    parsed = await response.json();
  } catch (error) {
    return { ok: false, message: `machine configuration could not be read: ${(error as Error).message}` };
  }
  /*
   * TOWER'S ENVELOPE, AND WHY IT IS READ HERE RATHER THAN REJECTED.
   *
   * `scripts/serve.mjs` and the dev server answer a bare array. Tower's mount
   * answers `{ signal, message, machines: [] }` when it cannot serve a list —
   * absent file, wrong mode, unparseable — because a bare empty array with no
   * reason reads as "you have no machines" for four different situations.
   *
   * Rejecting the object as "not a list of machines" threw that reason away and
   * replaced four specific sentences with one generic one, ON THE FIRST-RUN
   * PATH: no `client-machines.json` is the normal state for a fresh install, so
   * this was the message most operators would ever see from the mount. The
   * server's own words are the ones worth showing.
   */
  if (isRecord(parsed) && Array.isArray((parsed as { machines?: unknown }).machines)) {
    const envelope = parsed as { signal?: unknown; message?: unknown; machines: unknown[] };
    if (typeof envelope.message === 'string' && envelope.message !== '') {
      return { ok: false, message: envelope.message };
    }
    parsed = envelope.machines;
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'machine configuration is not a list of machines' };
  }
  /*
   * DUPLICATE IDS ARE DROPPED, NOT DEDUPLICATED SILENTLY OR LAST-ONE-WINS.
   *
   * Everything about a machine is keyed by its id — its connection state, its
   * human session, its React identity, the approval lookup — so two entries
   * sharing one id do not merely collide, they impersonate each other: a
   * session opened against the first machine would be presented to the second.
   * Keeping the first and counting the rest as dropped is the conservative
   * reading, and the count is what tells the human something was wrong with the
   * configuration rather than with a server.
   */
  const seen = new Set<string>();
  const machines: MachineConfig[] = [];
  for (const candidate of parsed) {
    if (!isMachine(candidate)) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    machines.push(candidate);
  }
  return { ok: true, machines, dropped: parsed.length - machines.length };
}

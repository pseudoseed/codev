import type { MachineConfig } from './connection/machine.js';

function isMachine(value: unknown): value is MachineConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.label === 'string'
    && typeof record.origin === 'string'
    && typeof record.workspacePath === 'string'
    && typeof record.credential === 'string';
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
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'machine configuration is not a list of machines' };
  }
  const machines = parsed.filter(isMachine);
  return { ok: true, machines, dropped: parsed.length - machines.length };
}

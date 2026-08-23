import { IDLE_WAITING_THRESHOLD_MS } from '@cluesmith/codev-sdk/builder-helpers';
import type { V2Status } from '@cluesmith/codev-types';

export function statusForBuilder(input: {
  blockedGate: string | null;
  live: boolean;
  lastDataAt: number | null;
  now: number;
}): V2Status {
  if (input.blockedGate !== null) return 'gate-waiting';
  if (!input.live) return 'offline';
  if (input.lastDataAt !== null && input.now - input.lastDataAt > IDLE_WAITING_THRESHOLD_MS) {
    return 'stalled';
  }
  return 'running';
}

export function statusForArchitect(live: boolean): V2Status {
  return live ? 'running' : 'offline';
}

export function statusForWorkspace(terminalCount: number): V2Status {
  return terminalCount > 0 ? 'running' : 'offline';
}

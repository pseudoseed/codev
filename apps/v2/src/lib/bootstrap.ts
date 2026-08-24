import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { escapePreview } from './validate.js';

export type BootstrapMismatch = {
  how: 'invalid-json' | 'bad-body';
  preview?: string;
  field?: string;
};

export type BootstrapOnce =
  | { kind: 'scoped'; paths: string[] }
  | { kind: 'empty' }
  | { kind: 'unreachable'; why: 'auth' | 'transport' }
  | { kind: 'mismatch'; mismatch: BootstrapMismatch };

export type BootstrapEnd =
  | { kind: 'scoped'; paths: string[] }
  | { kind: 'empty' }
  | { kind: 'mismatch'; mismatch: BootstrapMismatch }
  | { kind: 'aborted' };

export type BackoffFn = (ms: number, cb: () => void) => unknown;

const BACKOFF_START = 1000;
const BACKOFF_CAP = 15_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseWorkspacesBody(text: string): BootstrapOnce {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return {
      kind: 'mismatch',
      mismatch: { how: 'invalid-json', preview: escapePreview(text) },
    };
  }
  if (!isPlainObject(obj) || !Object.prototype.hasOwnProperty.call(obj, 'workspaces')) {
    return { kind: 'mismatch', mismatch: { how: 'bad-body', field: 'workspaces' } };
  }
  if (!Array.isArray(obj.workspaces)) {
    return { kind: 'mismatch', mismatch: { how: 'bad-body', field: 'workspaces' } };
  }
  const paths: string[] = [];
  for (const entry of obj.workspaces) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || entry.path === '') {
      return { kind: 'mismatch', mismatch: { how: 'bad-body', field: 'path' } };
    }
    paths.push(entry.path);
  }
  if (paths.length === 0) return { kind: 'empty' };
  return { kind: 'scoped', paths };
}

export async function fetchWorkspacesOnce(
  fetchFn: typeof globalThis.fetch,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<BootstrapOnce> {
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (key) headers[TOWER_KEY_HEADER] = key;
    res = await fetchFn('/api/workspaces', { headers, signal });
  } catch {
    return { kind: 'unreachable', why: 'transport' };
  }
  if (res.status !== 200) {
    const why = res.status === 401 || res.status === 403 ? 'auth' : 'transport';
    return { kind: 'unreachable', why };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return {
      kind: 'mismatch',
      mismatch: { how: 'invalid-json', preview: '' },
    };
  }
  return parseWorkspacesBody(text);
}

function wait(ms: number, reconnectBackoff: BackoffFn, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let id: unknown;
    const onAbort = () => {
      clearTimeout(id as number);
      resolve();
    };
    id = reconnectBackoff(ms, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runBootstrap(opts: {
  fetch: typeof globalThis.fetch;
  key: string | undefined;
  reconnectBackoff: BackoffFn;
  signal?: AbortSignal;
  onUnreachable?: (why: 'auth' | 'transport') => void;
  onMismatch?: (mismatch: BootstrapMismatch) => void;
}): Promise<BootstrapEnd> {
  let delay = BACKOFF_START;
  let mismatchAttempts = 0;
  while (!opts.signal?.aborted) {
    const result = await fetchWorkspacesOnce(opts.fetch, opts.key, opts.signal);
    if (opts.signal?.aborted) return { kind: 'aborted' };
    if (result.kind === 'scoped' || result.kind === 'empty') return result;
    if (result.kind === 'mismatch') {
      mismatchAttempts += 1;
      opts.onMismatch?.(result.mismatch);
      if (mismatchAttempts >= 2) return result;
      await wait(delay, opts.reconnectBackoff, opts.signal);
      delay = Math.min(delay * 2, BACKOFF_CAP);
      continue;
    }
    opts.onUnreachable?.(result.why);
    await wait(delay, opts.reconnectBackoff, opts.signal);
    delay = Math.min(delay * 2, BACKOFF_CAP);
  }
  return { kind: 'aborted' };
}

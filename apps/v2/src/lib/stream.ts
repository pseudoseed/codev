import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { runBootstrap, type BootstrapMismatch } from './bootstrap.js';
import { encodeScope } from './encode-scope.js';
import { getTowerKey } from './key.js';
import { applyFrame, initialReducerState, type ReducerState } from './reducer.js';
import { readSseData } from './sse-reader.js';

export type ConnectionState = 'loading' | 'unreachable' | 'reconnecting' | 'live';
export type ConnectionWhy = null | 'auth' | 'transport';
export type BootstrapPhase = 'pending' | 'scoped' | 'empty' | 'mismatch';

export type HttpMismatch = { status: number };

export type AppState = {
  connection: ConnectionState;
  connectionWhy: ConnectionWhy;
  bootstrap: BootstrapPhase;
  bootstrapMismatch: BootstrapMismatch | null;
  httpMismatch: HttpMismatch | null;
  /*
   * When the stream was last live (#106). A tree kept on screen through a
   * dropped connection is last-known, not current, and a stale tree that does
   * not say when it was last true reads as a live one.
   */
  lastLiveAt: string | null;
  reducer: ReducerState;
};

export type StreamDeps = {
  fetch: typeof globalThis.fetch;
  now?: () => string;
  getKey?: () => string | undefined;
  onState?: (state: AppState) => void;
};

export type Session = {
  stop: () => void;
  getState: () => AppState;
};

const BACKOFF_START = 1000;
const BACKOFF_CAP = 15_000;

export function reconnectBackoff(ms: number, cb: () => void): unknown {
  return setTimeout(cb, ms);
}

export function initialAppState(): AppState {
  return {
    connection: 'loading',
    connectionWhy: null,
    bootstrap: 'pending',
    bootstrapMismatch: null,
    httpMismatch: null,
    lastLiveAt: null,
    reducer: initialReducerState(),
  };
}

function eventsUrl(paths: string[], resume: { since: number; stream: string } | null): string {
  const q = `scope=${encodeScope(paths)}`;
  if (!resume) return `/v2/events?${q}`;
  return `/v2/events?${q}&since=${resume.since}&stream=${encodeURIComponent(resume.stream)}`;
}

function classifyStreamStatus(status: number): 'mismatch' | 'auth' | 'retry' {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'retry';
  return 'mismatch';
}

export function connect(deps: StreamDeps): Session {
  const state = initialAppState();
  const ctrl = new AbortController();
  let stopped = false;
  let timer: unknown = null;
  let delay = BACKOFF_START;
  const fetchFn = deps.fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const getKey = deps.getKey ?? getTowerKey;

  function emit(): void {
    deps.onState?.({
      ...state,
      bootstrapMismatch: state.bootstrapMismatch ? { ...state.bootstrapMismatch } : null,
      httpMismatch: state.httpMismatch ? { ...state.httpMismatch } : null,
    });
  }

  function leaveUnreachable(): void {
    if (state.connection === 'unreachable') {
      state.connection = 'loading';
      state.connectionWhy = null;
    }
  }

  function cancelBody(res: Response): void {
    void res.body?.cancel().catch(() => {});
  }

  function sessionBackoff(ms: number, cb: () => void): unknown {
    timer = reconnectBackoff(ms, () => {
      timer = null;
      cb();
    });
    return timer;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    ctrl.abort();
    if (timer !== null) {
      clearTimeout(timer as number);
      timer = null;
    }
  }

  function resetDelay(): void {
    delay = BACKOFF_START;
  }

  function waitBackoff(): Promise<void> {
    return new Promise((resolve) => {
      const ms = delay;
      delay = Math.min(delay * 2, BACKOFF_CAP);
      sessionBackoff(ms, () => resolve());
    });
  }

  function currentResume(): { since: number; stream: string } | null {
    const id = state.reducer.cursor.streamId;
    if (!id) return null;
    return { since: state.reducer.cursor.seq, stream: id };
  }

  async function openOnce(
    paths: string[],
    resume: { since: number; stream: string } | null,
  ): Promise<
    | 'halt'
    | 'recover-fresh'
    | 'eof'
    | 'applied-eof'
    | 'retry'
    | 'applied-retry'
    | 'no-retry'
    | 'aborted'
  > {
    if (stopped) return 'aborted';
    const key = getKey();
    const headers: Record<string, string> = {};
    if (key) headers[TOWER_KEY_HEADER] = key;
    let res: Response;
    try {
      res = await fetchFn(eventsUrl(paths, resume), { headers, signal: ctrl.signal });
    } catch {
      if (stopped || ctrl.signal.aborted) return 'aborted';
      state.connection = 'unreachable';
      state.connectionWhy = 'transport';
      emit();
      return 'retry';
    }
    if (stopped) return 'aborted';
    if (res.status !== 200) {
      cancelBody(res);
      const kind = classifyStreamStatus(res.status);
      if (kind === 'auth') {
        state.connection = 'unreachable';
        state.connectionWhy = 'auth';
        emit();
        return 'no-retry';
      }
      if (kind === 'mismatch') {
        leaveUnreachable();
        state.httpMismatch = { status: res.status };
        emit();
        return 'no-retry';
      }
      state.connection = 'unreachable';
      state.connectionWhy = 'transport';
      emit();
      return 'retry';
    }

    const body = res.body;
    if (!body) return 'eof';

    let applied = false;
    try {
      for await (const data of readSseData(body)) {
        if (stopped) return 'aborted';
        const result = applyFrame(state.reducer, data, now());
        state.reducer = result.state;
        if (result.effect === 'none' && result.state.mismatch === null) {
          applied = true;
          state.connection = 'live';
          state.connectionWhy = null;
          state.httpMismatch = null;
          state.lastLiveAt = now();
          resetDelay();
        }
        if (result.state.mismatch !== null) leaveUnreachable();
        emit();
        if (result.effect === 'recover-fresh') return 'recover-fresh';
        if (result.effect === 'halt') return 'halt';
      }
    } catch {
      if (stopped || ctrl.signal.aborted) return 'aborted';
      state.connection = 'unreachable';
      state.connectionWhy = 'transport';
      emit();
      return applied ? 'applied-retry' : 'retry';
    }
    if (stopped) return 'aborted';
    return applied ? 'applied-eof' : 'eof';
  }

  async function streamLoop(paths: string[]): Promise<void> {
    let forceFresh = false;
    while (!stopped) {
      const resume = forceFresh ? null : currentResume();
      const outcome = await openOnce(paths, resume);
      if (stopped || outcome === 'aborted' || outcome === 'halt' || outcome === 'no-retry') return;
      if (outcome === 'recover-fresh') {
        forceFresh = true;
        continue;
      }
      if (outcome === 'applied-eof' || outcome === 'applied-retry') forceFresh = false;
      if ((outcome === 'eof' || outcome === 'applied-eof') && !forceFresh) {
        state.connection = 'reconnecting';
        emit();
      }
      await waitBackoff();
    }
  }

  async function run(): Promise<void> {
    const boot = await runBootstrap({
      fetch: fetchFn,
      key: getKey(),
      signal: ctrl.signal,
      reconnectBackoff: sessionBackoff,
      onUnreachable: (why) => {
        state.connection = 'unreachable';
        state.connectionWhy = why;
        state.bootstrap = 'pending';
        emit();
      },
      onMismatch: (m) => {
        leaveUnreachable();
        state.bootstrap = 'mismatch';
        state.bootstrapMismatch = m;
        emit();
      },
    });
    if (stopped) return;
    if (boot.kind === 'aborted') return;
    if (boot.kind === 'empty') {
      state.bootstrap = 'empty';
      state.bootstrapMismatch = null;
      state.connection = 'live';
      state.connectionWhy = null;
      resetDelay();
      emit();
      return;
    }
    if (boot.kind === 'mismatch') {
      leaveUnreachable();
      state.bootstrap = 'mismatch';
      state.bootstrapMismatch = boot.mismatch;
      emit();
      return;
    }
    leaveUnreachable();
    state.bootstrap = 'scoped';
    state.bootstrapMismatch = null;
    state.connectionWhy = null;
    resetDelay();
    emit();
    await streamLoop(boot.paths);
  }

  void run();

  return { stop, getState: () => state };
}

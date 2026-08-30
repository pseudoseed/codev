/**
 * Spec 146 Phase 10 — porch, restarted, recovering from durable state alone.
 *
 * WHY THIS IS A SEPARATE PROCESS AND NOT A FUNCTION
 *
 * The first version of the restart step closed the subscription and the socket
 * and rebuilt them in the same process. Review was right that this proves less
 * than it claims: the `DriverThread`, the `TurnTracker`, the waiter promises and
 * the journal instance all survived, so what was demonstrated was stream
 * reconnection, not a porch that died and came back.
 *
 * This process shares nothing. It is handed a server URL, an access token, a
 * thread id, and the path to a cursor file. It has no thread object, no tracker,
 * no waiter, and no memory of the turn it is looking for. Everything it knows
 * about where to resume from, it reads off disk.
 *
 * WHAT IT REPORTS, AND WHY THAT PARTICULAR THING
 *
 * Whether the turn's completion event — `thread.session-set` with
 * `activeTurnId: null` — arrives in the **catch-up replay**, before the
 * `synchronized` marker, rather than live after it. That is the difference
 * between "the event was emitted while nobody was subscribed and came back" and
 * "the event happened to fire while we were watching", and only the first is the
 * criterion.
 *
 * It reports `sawSettleInCatchUp: false` rather than throwing when the event is
 * not there, because "it did not come back" and "I could not connect" are
 * different facts and the parent scores them differently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.env.RESUB_REPO_ROOT;
const base = process.env.RESUB_URL;
const accessToken = process.env.RESUB_ACCESS_TOKEN;
const threadId = process.env.RESUB_THREAD_ID;
const cursorPath = process.env.RESUB_CURSOR_PATH;
const waitMs = Number(process.env.RESUB_WAIT_MS ?? '120000');

const report = {
  cursorReadFromDisk: null,
  afterSequenceSent: null,
  synchronized: false,
  catchUpSequences: [],
  sawSettleInCatchUp: false,
  settleSequence: null,
  error: null,
};

try {
  const { WebSocket } = await import('ws');
  const { T3Client } = await import(join(repoRoot, 'packages/t3-client/dist/client.js'));
  const auth = await import(join(repoRoot, 'packages/t3-client/dist/auth.js'));
  const turnModule = await import(join(repoRoot, 'packages/porch-driver/dist/turn.js'));
  const { PersistentCursor } = await import(join(repoRoot, 'packages/porch-driver/dist/cursor.js'));

  // The ONLY state this process inherits. Not a variable handed across a
  // restart — a file, read by a process that has never seen the other one.
  const cursor = PersistentCursor.load(cursorPath);
  report.cursorReadFromDisk = cursor.applied;
  report.rawCursorFile = readFileSync(cursorPath, 'utf8').trim();

  const ticket = await auth.issueWebSocketTicket(base, accessToken);
  const socket = new WebSocket(auth.webSocketUrl(base, ticket.ticket));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('CONNECT_FAILED')), { once: true });
  });
  const client = new T3Client({
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener: (type, listener) => socket.addEventListener(type, listener),
    get readyState() {
      return socket.readyState;
    },
  });

  const payload = {
    threadId,
    requestCompletionMarker: true,
    afterSequence: cursor.applied,
  };
  report.afterSequenceSent = payload.afterSequence;

  let sawRunningInCatchUp = false;
  const done = new Promise((resolve) => {
    void client
      .stream('orchestration.subscribeThread', payload, (value) => {
        if (value?.kind === 'synchronized') {
          report.synchronized = true;
          resolve();
          return;
        }
        // Only what arrives BEFORE synchronization counts. Everything after it is
        // live, and a live completion is not a replayed one.
        if (report.synchronized) return;
        const event = turnModule.asThreadEvent(value);
        if (!event || event.aggregateId !== threadId) return;
        report.catchUpSequences.push(event.sequence);
        const activeTurnId = turnModule.activeTurnIdOf(event);
        if (activeTurnId === undefined) return;
        if (activeTurnId !== null) {
          sawRunningInCatchUp = true;
          return;
        }
        // A null before any running is the thread-creation shape, not a
        // completion — the same latch `TurnTracker` keeps, kept again here
        // because this process has no tracker to keep it.
        if (sawRunningInCatchUp && !report.sawSettleInCatchUp) {
          report.sawSettleInCatchUp = true;
          report.settleSequence = event.sequence;
        }
      }, waitMs)
      .catch((error) => {
        report.error = String(error).slice(0, 300);
        resolve();
      });
  });

  await Promise.race([done, new Promise((r) => setTimeout(r, waitMs))]);
  socket.close();
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 500);
}

console.log(JSON.stringify(report));
process.exit(0);

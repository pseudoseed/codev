/**
 * Deliver one mailbox message to a thread from a process that did not create it.
 *
 * This exists because the live test cannot see the gap it covers. That test drives
 * the engine directly, in a process that has already connected — which is exactly
 * the situation Tower is NOT in. Tower is a separate, long-lived process that
 * registers no engine of its own, so `deliverThreadTurn` threw there for every
 * thread-backed row and a bare `catch` turned it into a silent held message.
 *
 * So this runs as a real child process, against the BUILT dist rather than the
 * TypeScript source, and goes in through `makeDeliveryPorts().writeMessage` — the
 * same port Tower's mailbox drainer calls. Nothing here connects or attaches by
 * hand; if delivery works, it is because the production path did both.
 *
 * Reads from the environment (`CODEV_T3_URL` / `CODEV_T3_TOKEN` are what
 * `readThreadBackendConfig` accepts):
 *   AIR219_THREAD_ID, AIR219_WORKSPACE, AIR219_AGENT, AIR219_MESSAGE
 *
 * Prints one JSON object on stdout: `{ written, logs }`. `logs` carries the ERROR
 * lines the delivery port emitted, so a caller can tell WHICH of the four failures
 * happened rather than only that one did.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = require.resolve('../../../../dist/agent-farm/servers/mailbox-wiring.js');

const { makeDeliveryPorts } = await import(distDir);
const { threadDeliverySession } = await import(
  require.resolve('../../../../dist/agent-farm/servers/mailbox-delivery.js')
);

const logs = [];
const ports = makeDeliveryPorts((level, message) => {
  if (level === 'ERROR' || level === 'WARN') logs.push(`${level}: ${message}`);
});

const session = threadDeliverySession(process.env.AIR219_THREAD_ID, {
  workspaceRoot: process.env.AIR219_WORKSPACE,
  worktreePath: process.env.AIR219_WORKSPACE,
  branch: '',
  agent: process.env.AIR219_AGENT,
});

let written = false;
try {
  written = await ports.writeMessage(session, process.env.AIR219_MESSAGE, false);
} catch (err) {
  logs.push(`THREW: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(JSON.stringify({ written, logs }));
// The delivery path holds an open socket; nothing here owns it, so end explicitly
// rather than waiting on a handle this script did not open.
process.exit(0);

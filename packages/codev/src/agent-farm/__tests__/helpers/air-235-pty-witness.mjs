/**
 * Spec 146 Phase 10 — what modules did this process actually load?
 *
 * Phase 10's first deliverable ends "No PTY code path runs, asserted rather than
 * assumed." Everything in this repo that could assert it by reading source is an
 * assumption dressed up: an import graph says what CAN be reached, not what WAS.
 *
 * So this records what was. `module.register` installs a `resolve` hook that sees
 * every ESM specifier the process resolves, and posts the resolved URL back over
 * a `MessageChannel`. CJS is covered separately by the runner, off
 * `createRequire(...).cache` — `node-pty` is a native CJS addon, and `await
 * import('node-pty')` from ESM goes through the CJS loader, so it lands in both.
 *
 * THE LIMIT, STATED RATHER THAN LEFT TO BE DISCOVERED
 *
 * A hook sees only what is resolved AFTER it is registered. The runner registers
 * before it imports anything of its own, so every codev, porch-driver and
 * t3-client module is inside the window; Node's own bootstrap and the runner's
 * static builtin imports are outside it. That is exactly the right boundary for
 * this claim — the question is whether OUR code reached a PTY — but it is a
 * boundary, and a reader who assumed "every module ever" would be wrong.
 *
 * It also sees only THIS process. A PTY opened by a child process is invisible
 * here, which is why the runner asserts separately that no `terminal.*` command
 * was ever dispatched: that is the path through which the server would have
 * opened one on our behalf.
 */

/** @type {import('node:worker_threads').MessagePort | undefined} */
let port;

export function initialize(data) {
  port = data.port;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  // Post the RESOLVED url, not the specifier. `import('node-pty')` and a relative
  // import of the same file are the same fact and must record the same way.
  try {
    port?.postMessage(result.url);
  } catch {
    // A closed port must not take the module graph down with it. The runner
    // treats a short recording as UNDETERMINED rather than as "nothing loaded",
    // which is the only reading that stays honest if this ever fires.
  }
  return result;
}

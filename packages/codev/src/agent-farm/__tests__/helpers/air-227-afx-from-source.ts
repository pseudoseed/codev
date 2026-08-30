/**
 * `afx`, run from SOURCE, for the issue #227 live test.
 *
 * A copy of `bin/afx.js` with one line changed: it imports `../../cli.js` instead of
 * `dist/agent-farm/cli.js`. `cli.ts` only exports `runAgentFarm` — running the module
 * itself does nothing and exits 0, which is a silent pass wearing a success code, so the
 * invocation has to live somewhere.
 *
 * WHY NOT JUST RUN `bin/afx.js`. It imports `dist/`, a build artifact that can be older
 * than the change under test. A live test whose whole purpose is to stop shipping code no
 * production path exercises must not, at the last step, exercise a previous build of it.
 *
 * Not a test file, and named so vitest does not collect it.
 */
import { runAgentFarm } from '../../cli.js';

runAgentFarm(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

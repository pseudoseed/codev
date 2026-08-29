/**
 * Integration tests for Bridge Mode env vars.
 *
 * Verifies that the bridge mode system (BRIDGE_MODE + BRIDGE_TOWER_HOST)
 * correctly controls the Tower server bind address.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";

import {
  startTower,
  cleanupTestDb,
  createIsolatedAgentFarmDir,
  removeIsolatedAgentFarmDir,
} from "./helpers/tower-test-utils.js";

const PORT_DEFAULT = 14900;
const PORT_BRIDGE_ALL = 14901;
const PORT_BRIDGE_NO_HOST = 14902;
const PORT_INVALID = 14903;
const PORT_INSECURE = 14904;

let towerDefault: Awaited<ReturnType<typeof startTower>> | null = null;
let towerBridgeAll: Awaited<ReturnType<typeof startTower>> | null = null;
let towerBridgeNoHost: Awaited<ReturnType<typeof startTower>> | null = null;
let invalidProcess: ChildProcess | null = null;
/** stdout+stderr of the invalid-host spawn, so the exit can be checked for its REASON. */
let invalidOutput = "";

async function isHostResponding(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { resolve(false); });
    socket.connect(port, host);
  });
}

function isRespondingOnLocalhost(port: number): Promise<boolean> {
  return isHostResponding("127.0.0.1", port);
}

describe("Bridge Mode", () => {
  beforeAll(async () => {
    towerDefault = await startTower(PORT_DEFAULT, {});

    // Spec 146 Phase 7 changed this case's premise. A plaintext non-loopback bind
    // is now REFUSED at startup rather than warned about, so an exposed bind must
    // declare that a TLS terminator fronts it. Without CODEV_BRIDGE_TLS this
    // startup fails — which is the point, and is asserted separately below.
    towerBridgeAll = await startTower(PORT_BRIDGE_ALL, {
      BRIDGE_MODE: "1",
      BRIDGE_TOWER_HOST: "0.0.0.0",
      CODEV_BRIDGE_TLS: "terminated",
    });

    // Bridge mode enabled but no BRIDGE_TOWER_HOST — should fall back to 127.0.0.1
    towerBridgeNoHost = await startTower(PORT_BRIDGE_NO_HOST, {
      BRIDGE_MODE: "1",
    });

    // Invalid bridge host
    await import("node:path");
    // @ts-expect-error dynamic import resolved
    const { resolve } = await import("node:path");
    // Three levels, not four. Four resolves to `packages/dist/`, which does not
    // exist, so every spawn below died of MODULE_NOT_FOUND — and the only
    // assertion on it is `exitCode !== 0`, which MODULE_NOT_FOUND satisfies. The
    // test passed for years without ever reaching the code it names.
    const towerServerPath = resolve(
      import.meta.dirname,
      "../../../dist/agent-farm/servers/tower-server.js",
    );
    if (!existsSync(towerServerPath)) {
      throw new Error(
        `[bridge-mode e2e] tower-server.js not found at ${towerServerPath}. `
        + "Run `npm run build` first — a missing entrypoint would otherwise be "
        + "indistinguishable from the refusal this suite asserts.",
      );
    }

    const socketDir = mkdtempSync("/tmp/codev-sock-invalid-");
    const invalidAgentFarmDir = createIsolatedAgentFarmDir();
    invalidProcess = spawn("node", [towerServerPath, String(PORT_INVALID)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AF_TEST_DB: `test-${PORT_INVALID}.db`,
        SHELLPER_SOCKET_DIR: socketDir,
        CODEV_AGENT_FARM_DIR: invalidAgentFarmDir,
        CODEV_BRIDGE_TLS: "",
        BRIDGE_MODE: "1",
        BRIDGE_TOWER_HOST: "not-a-valid-host",
      },
    });

    invalidProcess.stdout?.on("data", (chunk) => { invalidOutput += String(chunk); });
    invalidProcess.stderr?.on("data", (chunk) => { invalidOutput += String(chunk); });

    await new Promise<void>((resolve) => {
      invalidProcess!.on("exit", () => resolve());
      setTimeout(() => {
        invalidProcess?.kill("SIGKILL");
        resolve();
      }, 5000);
    });

    try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // #1515: holds a copy of the shared local key — don't leave it behind.
    removeIsolatedAgentFarmDir(invalidAgentFarmDir);
  }, 30000);

  afterAll(async () => {
    if (towerDefault) await towerDefault.stop();
    if (towerBridgeAll) await towerBridgeAll.stop();
    if (towerBridgeNoHost) await towerBridgeNoHost.stop();
    cleanupTestDb(PORT_DEFAULT);
    cleanupTestDb(PORT_BRIDGE_ALL);
    cleanupTestDb(PORT_BRIDGE_NO_HOST);
    cleanupTestDb(PORT_INVALID);
  });

  describe("default behavior (no bridge mode)", () => {
    it("binds to localhost only", async () => {
      expect(await isRespondingOnLocalhost(PORT_DEFAULT)).toBe(true);
    });

    it("responds to /api/status on localhost", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_DEFAULT}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 with BRIDGE_TOWER_HOST=0.0.0.0", () => {
    it("binds to all interfaces (responds on localhost)", async () => {
      expect(await isRespondingOnLocalhost(PORT_BRIDGE_ALL)).toBe(true);
    });

    it("responds to /api/status", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_BRIDGE_ALL}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 without BRIDGE_TOWER_HOST", () => {
    it("falls back to 127.0.0.1 as default", async () => {
      expect(await isRespondingOnLocalhost(PORT_BRIDGE_NO_HOST)).toBe(true);
    });

    it("responds to /api/status", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_BRIDGE_NO_HOST}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 with invalid BRIDGE_TOWER_HOST", () => {
    it("causes tower to exit with non-zero code", () => {
      expect(invalidProcess?.exitCode).not.toBe(0);
      // `exitCode !== 0` alone is what let a MODULE_NOT_FOUND stand in for the
      // refusal. Naming the reason is what makes this an assertion about the
      // bind policy rather than about the process merely being dead.
      expect(invalidOutput).toContain("Invalid bind host");
    });
  });

  // Spec 146 Phase 7: the refusal itself, end to end. `decideBindPolicy` is unit
  // tested in agent-auth.test.ts; this asserts the wiring — that a real Tower
  // process told to expose an interface with no TLS declaration exits instead of
  // serving, and says which variable to set.
  describe("BRIDGE_MODE=1 exposing an interface with no TLS declaration", () => {
    it("refuses to start, naming CODEV_BRIDGE_TLS", async () => {
      const { resolve } = await import("node:path");
      const towerServerPath = resolve(
        import.meta.dirname,
        "../../../dist/agent-farm/servers/tower-server.js",
      );
      const socketDir = mkdtempSync("/tmp/codev-bridge-tls-");
      const agentFarmDir = createIsolatedAgentFarmDir(PORT_INSECURE);
      const child = spawn("node", [towerServerPath, String(PORT_INSECURE)], {
        env: {
          ...process.env,
          AF_TEST_DB: `test-${PORT_INSECURE}.db`,
          SHELLPER_SOCKET_DIR: socketDir,
          CODEV_AGENT_FARM_DIR: agentFarmDir,
          // Explicitly empty: the whole point of this case is that an exposed
          // bind with NO declaration is refused, so an ambient one would make it
          // pass for the wrong reason.
          CODEV_BRIDGE_TLS: "",
          BRIDGE_MODE: "1",
          BRIDGE_TOWER_HOST: "0.0.0.0",
        },
      });
      let stderr = "";
      let stdout = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on("exit", (code) => resolveExit(code));
        setTimeout(() => { child.kill("SIGKILL"); resolveExit(null); }, 10000);
      });
      rmSync(socketDir, { recursive: true, force: true });
      removeIsolatedAgentFarmDir(agentFarmDir);
      cleanupTestDb(PORT_INSECURE);

      expect(exitCode).toBe(1);
      const output = `${stdout}${stderr}`;
      expect(output).toContain("INSECURE_NON_LOOPBACK_BIND_REFUSED");
      // The refusal has to say how to proceed, or the operator deletes the check.
      expect(output).toContain("CODEV_BRIDGE_TLS=terminated");
      // And nothing is listening on that port.
      expect(await isRespondingOnLocalhost(PORT_INSECURE)).toBe(false);
    }, 20000);
  });
});

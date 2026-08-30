/**
 * Spec 146 Phase 9, issue #179 items 1 and 2 — the production path to a real engine.
 *
 * Item 1 was "the only engine reachable in production is none": `createPorchThreadEngine`
 * lived under `__tests__/helpers/` and imported porch-driver by a relative path into its
 * gitignored `dist/`, while `porch-driver` was `private: true` and absent from this
 * package's dependencies. Item 2 was that `installThreadSpawnFactory` had no caller
 * outside tests, so `chooseSpawnPath` returned `pty` unconditionally.
 *
 * The manifest assertions below are the durable half. Moving the engine into `src/` is
 * undone by one `private: true`, and nothing else in the suite would notice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseSpawnPath, setSpawnThreadFactory } from '../db/thread-identity.js';
import { setThreadEngine, createMemoryThreadEngine } from '../thread-runtime.js';
import {
  activeProjectForWorkspace,
  ensureThreadBackendReady,
  readThreadBackendConfig,
  webSocketCtor,
  classifyConnectFailure,
} from '../thread-backend.js';
import { launchSpawnedBuilder } from '../commands/spawn.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');

/**
 * This file's connect tests drive `ensureThreadBackendReady` for real, so they need
 * `@cluesmith/t3-client`'s entry point — which resolves to `./dist/client.js`, a build
 * output that is gitignored.
 *
 * Asserted BY NAME, once, before any test runs. Without this the missing artifact arrives
 * as eight connect tests disagreeing about which failure state they got, which sends the
 * reader into `classifyConnectFailure` — a function that is working correctly. That is
 * issue #200's fourth part: a test that depends on a build artifact with nothing asserting
 * the artifact exists, so the failure presents as something else entirely.
 *
 * Deliberately NOT a `skipIf`. A skip is how the packed-imports test stayed invisible to CI
 * for its entire life: a green suite absorbs an honest "could not check" exactly as
 * completely as it absorbs a pass. Fail loudly, immediately, and name the remedy.
 *
 * A suite-wide declared build prerequisite would make this redundant: **delete this block if
 * issue #212 lands.** That issue carries both instances from opposite directions — the packed-
 * imports test skipping invisibly because it runs in neither CI job, and these eight failures
 * pointing at `classifyConnectFailure` while that function works correctly.
 */
const T3_CLIENT_DIST = resolve(repoRoot, 'packages/t3-client/dist/client.js');
if (!existsSync(T3_CLIENT_DIST)) {
  throw new Error(
    `spec-146-phase-9-thread-backend.test.ts requires packages/t3-client to be built: `
    + `${T3_CLIENT_DIST} does not exist. Its connect tests import @cluesmith/t3-client/client, `
    + `which resolves into that gitignored dist/. Run the workspace build (\`pnpm -w run build\`) `
    + `and re-run. This is a missing build artifact, not a failure of the code under test.`,
  );
}
const pkg = (rel: string) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

describe('Spec 146 Phase 9 — the engine is reachable in production (#179 item 1)', () => {
  it('the engine lives in src, not under __tests__', () => {
    expect(existsSync(join(repoRoot, 'packages/codev/src/agent-farm/porch-thread-engine.ts'))).toBe(true);
  });

  it('porch-driver is a real dependency of @cluesmith/codev', () => {
    const deps = pkg('packages/codev/package.json').dependencies as Record<string, string>;
    expect(deps['@cluesmith/porch-driver']).toBe('workspace:*');
  });

  it('porch-driver and its own dependency t3-client are publishable, not private', () => {
    // A published package cannot depend on a private one: `workspace:*` resolves to a
    // version at publish time, and a private package is never published. Both must go.
    expect(pkg('packages/porch-driver/package.json').private).toBeUndefined();
    expect(pkg('packages/t3-client/package.json').private).toBeUndefined();
    expect(pkg('packages/porch-driver/package.json').dependencies['@cluesmith/t3-client'])
      .toBe('workspace:*');
  });

  /**
   * Every place that hand-enumerates @cluesmith/codev's runtime workspace dependencies.
   *
   * The dependency set grew by two in this phase, and the first fix taught only
   * `pnpm publish` about it — the release commit's `git add` and `local-install.sh`
   * still enumerated the old set, so `pnpm -w run local-install` would E404 on a
   * package the tarball now requires. Reading the set from the manifest rather than
   * repeating it here is what makes the NEXT dependency addition fail loudly instead
   * of repeating this. Extra entries in these lists are fine; missing ones are not.
   */
  const workspaceDeps = () => {
    const deps = pkg('packages/codev/package.json').dependencies as Record<string, string>;
    return Object.keys(deps)
      .filter((name) => name.startsWith('@cluesmith/'))
      .map((name) => {
        // Resolve name → directory from the manifests themselves; `@cluesmith/codev-types`
        // lives at `packages/types`, so the name is not the path.
        const dir = readdirSync(join(repoRoot, 'packages')).find((d) => {
          const manifest = join(repoRoot, 'packages', d, 'package.json');
          return existsSync(manifest) && pkg(`packages/${d}/package.json`).name === name;
        });
        if (!dir) throw new Error(`No packages/* directory declares ${name}`);
        return { name, path: `packages/${dir}` };
      });
  };

  it('every workspace dependency is version-aligned with @cluesmith/codev', () => {
    // Dropping `private: true` makes a package publishable; it does not make it published.
    // pnpm rewrites `workspace:*` to the dependency's own version at publish time, so a
    // porch-driver left at 0.0.0 ships as `"@cluesmith/porch-driver": "0.0.0"` — a version
    // that is not on the registry, and `npm install -g @cluesmith/codev` fails with E404.
    const released = pkg('packages/codev/package.json').version;
    const deps = workspaceDeps();
    expect(deps.length).toBeGreaterThan(0);
    for (const { name, path } of deps) {
      const manifest = pkg(`${path}/package.json`);
      expect({ name, version: manifest.version }).toEqual({ name, version: released });
      expect({ name, private: manifest.private }).toEqual({ name, private: undefined });
      // Every one of these ships its dist/ (gitignored) and points `exports.*.default` there,
      // and release step 7 publishes them BEFORE @cluesmith/codev — so codev's own
      // prepublishOnly build has not run yet. Without this, a clean checkout publishes a
      // tarball containing `src` and no `dist`: the install succeeds and the first
      // `afx spawn` dies on ERR_MODULE_NOT_FOUND. A dirty tree silently ships whatever
      // happens to be sitting in dist/. npm publishes cannot be taken back.
      expect({ name, prepublishOnly: manifest.scripts?.prepublishOnly })
        .toEqual({ name, prepublishOnly: 'pnpm build' });
    }
  });

  it('the release tooling bumps, stages and publishes every one of them', () => {
    // Version alignment above is a fact about today's tree; these assertions are what
    // keeps it true across the next release. Every file here is edited by hand.
    const bump = readFileSync(join(repoRoot, 'scripts/bump-all.sh'), 'utf8');
    const release = readFileSync(join(repoRoot, 'codev/protocols/release/protocol.md'), 'utf8');
    const publishLines = release.split('\n').filter((l) => l.startsWith('pnpm publish --filter'));
    const stagingLines = release.split('\n').filter((l) => l.startsWith('git add package.json'));
    // Without these the loops below pass vacuously if the protocol is ever restructured.
    expect(publishLines.length).toBeGreaterThan(0);
    expect(stagingLines.length).toBeGreaterThan(0);

    for (const { name, path } of workspaceDeps()) {
      expect({ name, inBump: bump.includes(path) }).toEqual({ name, inBump: true });
      for (const line of publishLines) {
        expect({ name, published: line.includes(`--filter '${name}'`) }).toEqual({ name, published: true });
      }
      for (const line of stagingLines) {
        expect({ name, staged: line.includes(`${path}/package.json`) }).toEqual({ name, staged: true });
      }
    }
  });

  it('CI builds and install-verifies every one of them', () => {
    // The site the manifest guard did not know about, and the one that caught a gap
    // predating this branch: CI built porch-driver in one job, t3-client in NEITHER, so it
    // was building a package whose own dependency it never built. That stayed invisible
    // while nothing imported t3-client at test time.
    //
    // Seven enumeration sites now carry this dependency set — bump, publish, two release
    // `git add` lines, four local-install lists, the CI build steps, and verify-install's
    // argv. That is well past what anyone holds in their head, which is the argument for
    // reading them rather than remembering them.
    const workflow = readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8');
    const verifyLine = workflow
      .split('\n')
      .find((l) => l.includes('verify-install.mjs'));
    expect(verifyLine, 'the install-verification step must exist to be checked').toBeDefined();

    for (const { name, path } of workspaceDeps()) {
      // Built somewhere in CI, or its dist/ — a gitignored build output every one of these
      // points `exports.*.default` into — simply does not exist in any job.
      //
      // The `run:` line has to build (#214). This originally matched the working-directory
      // alone, which counts ANY step in that package — a copy, a lint, a test — as a build.
      // That is the vacuous-pass shape, inside a guard written to prevent a vacuous pass:
      // `packages/codev` carries a `copy-skeleton` step, so the assertion would have passed
      // over a job that never built it. Same criterion as the publish-scrub guard, so the
      // two cannot disagree about what a build is.
      // `path` is escaped: a package directory carrying a `.` or `+` would otherwise loosen
      // the match rather than tighten it, which is the wrong direction for a guard.
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const buildsIt = new RegExp(`working-directory: ${escaped}\\s*\\n\\s*run: [^\\n]*pnpm build`).test(workflow);
      expect({ name, built: buildsIt }).toEqual({ name, built: true });
      // And packed into the tarball set that `npm install -g` is verified against, or npm
      // resolves it from the registry mid-verification.
      const dir = path.replace(/^packages\//, '');
      expect({ name, installVerified: verifyLine!.includes(`../${dir}/`) || verifyLine!.includes('cluesmith-codev-*.tgz') && dir === 'codev' })
        .toEqual({ name, installVerified: true });
    }
  });

  it('local-install packs and installs every one of them', () => {
    // `pnpm -w run local-install` is the step that makes a merged change visible to
    // Tower, and it runs far more often than a release. `pnpm pack` rewrites
    // `workspace:*` the same way `pnpm publish` does, so a dependency missing here
    // makes npm resolve it from the registry and the install fails before Tower restarts.
    const script = readFileSync(join(repoRoot, 'scripts/local-install.sh'), 'utf8');
    const uninstallLine = script.split('\n').find((l) => l.startsWith('npm uninstall -g '));
    expect(uninstallLine).toBeDefined();

    for (const { name, path } of workspaceDeps()) {
      expect({ name, packed: script.includes(`pnpm --filter ${name} pack`) })
        .toEqual({ name, packed: true });
      expect({ name, uninstalled: uninstallLine!.includes(` ${name}`) })
        .toEqual({ name, uninstalled: true });
      expect({ name, installed: script.includes(`$REPO_ROOT/${path}/`) })
        .toEqual({ name, installed: true });
    }
  });

  it('the production engine does not import porch-driver by a relative path out of the package', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/porch-thread-engine.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from '\.\..*porch-driver/);
    expect(src).toContain("from '@cluesmith/porch-driver/thread'");
  });
});

describe('Spec 146 Phase 9 — production spawn wiring (#179 item 2)', () => {
  let dir: string | undefined;

  afterEach(() => {
    setThreadEngine(undefined);
    setSpawnThreadFactory(undefined, undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function workspace(config?: unknown): string {
    dir = mkdtempSync(join(tmpdir(), 'phase9-backend-'));
    if (config !== undefined) {
      mkdirSync(join(dir, '.codev'), { recursive: true });
      writeFileSync(join(dir, '.codev', 'config.json'), JSON.stringify(config));
    }
    return dir;
  }

  it('a workspace with no t3code server configured stays on the PTY path', async () => {
    const root = workspace();
    await expect(ensureThreadBackendReady(root)).resolves.toBe('not-configured');
    expect(chooseSpawnPath(undefined, undefined)).toBe('pty');
  });

  it('a config with no threads block is not configured', () => {
    expect(readThreadBackendConfig(workspace({ shell: {} }))).toBeNull();
  });

  it('reads threads from .codev/config.local.json, the per-engineer gitignored layer', () => {
    // The reason this goes through `loadConfig` instead of reading `.codev/config.json`
    // directly. An engineer putting `threads` in the local override previously got
    // `not-configured` — "I did not look there" spelled exactly like "there is none" — and the
    // only way to keep a token out of git was to gitignore the committed config, which also
    // carries the shell block teams reasonably commit.
    dir = mkdtempSync(join(tmpdir(), 'phase9-local-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(join(dir, '.codev', 'config.json'), JSON.stringify({ shell: {} }));
    writeFileSync(
      join(dir, '.codev', 'config.local.json'),
      JSON.stringify({ threads: { serverUrl: 'http://127.0.0.1:3799', bootstrapToken: 'local-tok' } }),
    );

    expect(readThreadBackendConfig(dir)).toMatchObject({
      serverUrl: 'http://127.0.0.1:3799',
      bootstrapToken: 'local-tok',
    });
  });

  it('the committed config alone still works, and the local layer wins where both set it', () => {
    dir = mkdtempSync(join(tmpdir(), 'phase9-layers-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(
      join(dir, '.codev', 'config.json'),
      JSON.stringify({ threads: { serverUrl: 'http://committed:1', bootstrapToken: 'committed' } }),
    );
    expect(readThreadBackendConfig(dir)).toMatchObject({ bootstrapToken: 'committed' });

    writeFileSync(
      join(dir, '.codev', 'config.local.json'),
      JSON.stringify({ threads: { bootstrapToken: 'local' } }),
    );
    // Layer 5 beats layer 4, and the serverUrl the local file does not set is still inherited.
    expect(readThreadBackendConfig(dir)).toMatchObject({
      serverUrl: 'http://committed:1',
      bootstrapToken: 'local',
    });
  });

  it('an unparseable config throws rather than reading as not-configured', () => {
    // A config file that cannot be parsed is "I could not tell", and returning null would
    // spell it the same way as "this workspace has no server", which is a decision.
    dir = mkdtempSync(join(tmpdir(), 'phase9-backend-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(join(dir, '.codev', 'config.json'), '{ not json');
    expect(() => readThreadBackendConfig(dir!)).toThrow(/Failed to parse/);
  });

  it('a half-configured threads block throws rather than silently staying on PTY', () => {
    expect(() => readThreadBackendConfig(workspace({ threads: { serverUrl: 'http://127.0.0.1:3799' } })))
      .toThrow(/bootstrapToken=missing/);
    expect(() => readThreadBackendConfig(workspace({ threads: { bootstrapToken: 'tok' } })))
      .toThrow(/serverUrl=missing/);
  });

  it('reads a complete threads block', () => {
    const config = readThreadBackendConfig(workspace({
      threads: { serverUrl: 'http://127.0.0.1:3799', bootstrapToken: 'tok', harness: 'codex', model: 'm' },
    }));
    expect(config).toMatchObject({
      serverUrl: 'http://127.0.0.1:3799',
      bootstrapToken: 'tok',
      defaultHarness: 'codex',
      defaultModel: 'm',
    });
  });

  it('a configured but unreachable server throws — it is not spelled the same way as unconfigured', async () => {
    // Port 1 is reserved and refuses; the point is that this does NOT resolve to
    // 'not-configured' and does NOT leave the caller quietly on the PTY path.
    const root = workspace({ threads: { serverUrl: 'http://127.0.0.1:1', bootstrapToken: 'tok' } });
    await expect(ensureThreadBackendReady(root)).rejects.toThrow(/could not be reached/);
  });

  it('an engine already registered FOR THIS WORKSPACE is left alone', async () => {
    const root = workspace();
    setThreadEngine(createMemoryThreadEngine(), root);
    await expect(ensureThreadBackendReady(root)).resolves.toBe('already-installed');
  });

  /**
   * #219 round 3. This check read an unkeyed slot, so in Tower — one process, every
   * workspace in `global.db` — the first thread-configured workspace to connect made
   * every later one return `already-installed` and then use its socket and its project.
   */
  it('an engine registered for ANOTHER workspace does not count as installed here', async () => {
    // Its own directory rather than a second `workspace()` call: that helper reassigns
    // the shared `dir` the teardown removes, so the first one would be left behind.
    const other = mkdtempSync(join(tmpdir(), 'phase9-other-'));
    try {
      setThreadEngine(createMemoryThreadEngine(), other);
      // A second workspace, with no `threads` block of its own: the honest answer is
      // "not configured", never "already installed".
      await expect(ensureThreadBackendReady(workspace({}))).resolves.toBe('not-configured');
    } finally {
      setThreadEngine(undefined, other);
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('launchSpawnedBuilder forwards the mission to the factory, not only to the PTY closure', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setSpawnThreadFactory(async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return 'thr-1';
    });
    const identity = await launchSpawnedBuilder({
      existing: { threadId: undefined, terminalId: undefined },
      builderId: 'b1',
      worktreePath: '/tmp/wt',
      branch: 'builder/b1',
      prompt: 'IMPLEMENT ISSUE 179',
      roleContent: 'YOU ARE A BUILDER',
      roleFilePath: '/tmp/wt/.builder-role.md',
      startPty: async () => {
        throw new Error('the thread path must not fall through to the PTY');
      },
    });

    expect(identity).toEqual({ threadId: 'thr-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prompt: 'IMPLEMENT ISSUE 179',
      roleContent: 'YOU ARE A BUILDER',
      roleFilePath: '/tmp/wt/.builder-role.md',
    });
  });

  it('every spawn call site gives the thread path something to run', () => {
    // The behaviour test above proves the forwarding; this proves the call sites
    // actually use it. They passed the generated prompt only into their `startPty`
    // closure, so on the thread path the engine got `prompt: undefined`, never began a
    // turn, and produced a thread that had been told nothing. Nothing in the suite
    // noticed, because the parity test asserted an in-memory `launched` boolean.
    //
    // A worktree spawn is the one form with no prompt by definition — its payload is
    // the launch script — so either satisfies the payload half.
    //
    // The role half has no exception, and that is the correction: the first version of this
    // guard checked `prompt` OR `launchScript` only, which the worktree site satisfied with
    // `launchScript` while silently passing no role at all. A guard that cannot fail for the
    // one call site that differs is not guarding it. Every site loads a role and every site
    // must forward it, whatever its payload.
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn.ts'),
      'utf8',
    );
    const calls: string[] = [];
    let from = src.indexOf('await launchSpawnedBuilder({');
    while (from !== -1) {
      const end = src.indexOf('\n  });', from);
      expect(end).toBeGreaterThan(from);
      calls.push(src.slice(from, end));
      from = src.indexOf('await launchSpawnedBuilder({', end);
    }
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const [index, call] of calls.entries()) {
      expect({ index, carriesPayload: /\n\s+(prompt[,:]|launchScript:)/.test(call) })
        .toEqual({ index, carriesPayload: true });
      expect({ index, carriesRole: /\n\s+roleContent:/.test(call) })
        .toEqual({ index, carriesRole: true });
    }
  });

  it('launchSpawnedBuilder calls the wiring — the production caller exists', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn.ts'),
      'utf8',
    );
    expect(src).toContain('ensureThreadBackendReady');
    // ...and before the path decision, or it could never change the outcome.
    expect(src.indexOf('ensureThreadBackendReady(opts.workspaceRoot)'))
      .toBeLessThan(src.indexOf('const pathKind = chooseSpawnPath'));
  });
});

describe('Spec 146 Phase 9 — connecting on the minimum supported Node (iter 3)', () => {
  const globals = globalThis as { WebSocket?: unknown };
  const platformWebSocket = globals.WebSocket;

  afterEach(() => {
    if (platformWebSocket === undefined) delete globals.WebSocket;
    else globals.WebSocket = platformWebSocket;
  });

  it('the package supports a Node with no global WebSocket, so the code must not assume one', () => {
    // The pin the runner cannot drift away from: it is about the DECLARED minimum, not the
    // version this suite happens to run on. Node 20 has no global `WebSocket` and
    // `engines.node` says 20 is supported, so constructing the global was a ReferenceError on
    // a runtime we promise to work on — thrown AFTER the bootstrap token was exchanged, so a
    // configured spawn burned its credential and then failed.
    const manifest = pkg('packages/codev/package.json');
    expect((manifest.engines as { node: string }).node).toMatch(/>=\s*20/);
    expect((manifest.dependencies as Record<string, string>).ws).toBeTruthy();

    const src = readFileSync(join(repoRoot, 'packages/codev/src/agent-farm/thread-backend.ts'), 'utf8');
    expect(src).not.toMatch(/new WebSocket\(/);
  });

  it('resolves a usable constructor when there is no global WebSocket', async () => {
    // The condition, forced, rather than waiting for a runtime that happens to lack it.
    delete globals.WebSocket;
    const ctor = await webSocketCtor();
    expect(typeof ctor).toBe('function');
    const proto = (ctor as unknown as { prototype: Record<string, unknown> }).prototype;
    expect(typeof proto.addEventListener).toBe('function');
    expect(typeof proto.send).toBe('function');
    expect(typeof proto.close).toBe('function');
  });

  it('prefers the platform WebSocket where the runtime has one', async () => {
    // A compatibility shim, not a switch to `ws` everywhere: a newer Node keeps its own.
    class FakePlatformSocket {}
    globals.WebSocket = FakePlatformSocket;
    await expect(webSocketCtor()).resolves.toBe(FakePlatformSocket);
  });
});

describe('Spec 146 Phase 9 — a refused credential is not an unreachable server (iter 3)', () => {
  let server: { close(cb: () => void): void } | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    setThreadEngine(undefined);
    setSpawnThreadFactory(undefined, undefined);
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function workspaceAt(serverUrl: string): string {
    dir = mkdtempSync(join(tmpdir(), 'phase9-credential-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(
      join(dir, '.codev', 'config.json'),
      JSON.stringify({ threads: { serverUrl, bootstrapToken: 'already-consumed' } }),
    );
    return dir;
  }

  async function messageFrom(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected ensureThreadBackendReady to throw, and it resolved');
  }

  it('a consumed one-time token reads as a refusal and names the cause', async () => {
    // What a SECOND spawn sees. Every `afx` invocation is a fresh process and exchanges the
    // token again; a pairing-issued token is one-time — `PairingGrantStore.consume` deletes
    // the grant at `remainingUses <= 1` — so the next process gets this back. Calling it
    // "could not be reached" would send the reader to check the network for a healthy server.
    const http = await import('node:http');
    const created = http.createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnknownBootstrapCredentialError' }));
    });
    server = created;
    await new Promise<void>((res) => created.listen(0, '127.0.0.1', () => res()));
    const { port } = created.address() as { port: number };

    const message = await messageFrom(ensureThreadBackendReady(workspaceAt(`http://127.0.0.1:${port}`)));
    expect(message).toMatch(/REFUSED the bootstrap token/);
    expect(message).toMatch(/one-time token/);
    expect(message).toMatch(/server is reachable/i);
    expect(message).not.toMatch(/could not be reached/);
  });

  it('an unreachable server still reads as unreachable, not as a refusal', async () => {
    // The control. Without it the assertion above would hold just as well if every failure
    // were relabelled a refusal, which is the same defect pointing the other way.
    const message = await messageFrom(ensureThreadBackendReady(workspaceAt('http://127.0.0.1:1')));
    expect(message).toMatch(/could not be reached/);
    expect(message).not.toMatch(/REFUSED/);
  });
});

describe('Spec 146 Phase 9 — four connect failures, four sentences (iter 3 fix)', () => {
  let server: { close(cb: () => void): void } | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    setThreadEngine(undefined);
    setSpawnThreadFactory(undefined, undefined);
    for (const s of heldSockets.splice(0)) { try { s.destroy(); } catch { /* already gone */ } }
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function workspaceAt(serverUrl: string): string {
    dir = mkdtempSync(join(tmpdir(), 'phase9-connect-'));
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(
      join(dir, '.codev', 'config.json'),
      JSON.stringify({ threads: { serverUrl, bootstrapToken: 'tok' } }),
    );
    return dir;
  }

  async function messageFrom(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected ensureThreadBackendReady to throw, and it resolved');
  }

  /**
   * A server that answers the two auth calls however the test asks and then, on the WebSocket
   * upgrade, HOLDS THE SOCKET OPEN without replying.
   *
   * The `upgrade` listener is load-bearing and its absence is not equivalent: a plain
   * `http.Server` with no listener DESTROYS an upgrade socket, which fires the client's `error`
   * handler and produces the "unreachable" message, not the hang. The first version of this
   * fixture omitted it and the test failed — asserting the state it meant while the fixture
   * produced a different one. Keeping a reference to the socket stops it being garbage collected.
   */
  const heldSockets: Array<{ destroy(): void }> = [];
  async function stub(handler: (url: string) => { status: number; body: unknown }): Promise<string> {
    const http = await import('node:http');
    const created = http.createServer((req, res) => {
      const { status, body } = handler(req.url ?? '');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    created.on('upgrade', (_req, socket) => {
      heldSockets.push(socket as unknown as { destroy(): void });
    });
    server = created;
    await new Promise<void>((res) => created.listen(0, '127.0.0.1', () => res()));
    const { port } = created.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  const ok = { status: 200, body: { access_token: 'a', ticket: 't' } };

  it('a refused bootstrap token blames the TOKEN', async () => {
    const url = await stub(() => ({ status: 400, body: { _tag: 'UnknownBootstrapCredentialError' } }));
    const message = await messageFrom(ensureThreadBackendReady(workspaceAt(url)));
    expect(message).toMatch(/REFUSED the bootstrap token/);
    expect(message).toMatch(/one-time token/);
    expect(message).not.toMatch(/could not be reached|never completed|refused to issue/);
  });

  it('a refused ticket does NOT blame the token — it happens after the token was accepted', async () => {
    // The third instance of this phase's own defect, found by the opencode lane: the first
    // version matched any AuthError and reported every one as a spent bootstrap token. A 4xx
    // here means the credential was already ACCEPTED and something failed one step later.
    const url = await stub((u) =>
      u.includes('websocket-ticket') ? { status: 403, body: { _tag: 'Forbidden' } } : ok,
    );
    const message = await messageFrom(ensureThreadBackendReady(workspaceAt(url)));
    expect(message).toMatch(/ACCEPTED the bootstrap token/);
    expect(message).toMatch(/refused to issue a WebSocket ticket/);
    expect(message).toMatch(/not evidence that the token is spent/);
    expect(message).not.toMatch(/REFUSED the bootstrap token|one-time token/);
  });

  it('a server that accepts the connection and never upgrades is neither refusing nor unreachable', async () => {
    // The state that previously hung forever: both listeners are `{ once: true }` and neither
    // fires, so the await never settled and the spawn reported nothing at all.
    const url = await stub(() => ok); // no 'upgrade' listener — the socket is accepted and ignored
    const message = await messageFrom(
      ensureThreadBackendReady(workspaceAt(url), { upgradeTimeoutMs: 400 }),
    );
    expect(message).toMatch(/never completed the/);
    expect(message).toMatch(/WebSocket upgrade within 400ms/);
    expect(message).toMatch(/neither unreachable nor refusing/);
    expect(message).not.toMatch(/REFUSED the bootstrap token|could not be reached/);
  }, 20_000);

  it('an unreachable server still reads as unreachable', async () => {
    const message = await messageFrom(ensureThreadBackendReady(workspaceAt('http://127.0.0.1:1')));
    expect(message).toMatch(/could not be reached/);
    expect(message).not.toMatch(/REFUSED|ACCEPTED|never completed/);
  });

  it('a missing client module is a local fault, not an unreachable server', async () => {
    // The fifth state, and it was folded into `unreachable` until CI surfaced it: the
    // t3-client entry point resolves to `./dist/client.js`, a build output, and CI never
    // built that package. Reporting "could not be reached" sent the reader to check a
    // network for a server nothing had contacted.
    const missing = new Error("Cannot find module '@cluesmith/t3-client/client'") as Error & { code: string };
    missing.code = 'ERR_MODULE_NOT_FOUND';
    expect(classifyConnectFailure(missing)).toBe('client-missing');
  });

  it('the five messages are mutually exclusive — no state reads as another', async () => {
    // The point of the set. Each assertion above says what its own state looks like; only
    // comparing them proves none of the four is spelled like another, which is the whole claim.
    const refusedUrl = await stub(() => ({ status: 400, body: { _tag: 'UnknownBootstrapCredentialError' } }));
    const refused = await messageFrom(ensureThreadBackendReady(workspaceAt(refusedUrl)));
    await new Promise<void>((res) => server!.close(() => res()));
    rmSync(dir!, { recursive: true, force: true });

    const unreachable = await messageFrom(ensureThreadBackendReady(workspaceAt('http://127.0.0.1:1')));

    const signatures = [refused, unreachable].map((m) => ({
      token: /REFUSED the bootstrap token/.test(m),
      unreachable: /could not be reached/.test(m),
      hung: /never completed the/.test(m),
      clientMissing: /could not be loaded/.test(m),
      ticket: /refused to issue a WebSocket ticket/.test(m),
    }));
    // Every message matches exactly one signature, and no two match the same one.
    for (const sig of signatures) {
      expect(Object.values(sig).filter(Boolean)).toHaveLength(1);
    }
    expect(signatures[0]).not.toEqual(signatures[1]);
  });
});

/**
 * Issue #219 — `project.create` is not idempotent, and the second `afx` process paid
 * for it.
 *
 * t3code refuses a second active project for a workspace root
 * (`requireActiveProjectWorkspaceRootAbsent`). `ensureThreadBackendReady` created one
 * unconditionally, so it worked in the FIRST process to run against a workspace and
 * failed in every one after — and every `afx` invocation is a fresh process. It
 * surfaced as "the server was named and could not be used", which sends a reader to
 * check a healthy server.
 *
 * These drive the lookup against a real HTTP server rather than a mocked `fetch`,
 * because the thing under test is what a response actually looks like.
 */
describe('Spec 146 Phase 9 — the existing project is found, not re-created (#219)', () => {
  let server: import('node:http').Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
  });

  async function serve(handler: (req: unknown, res: {
    statusCode: number;
    setHeader(k: string, v: string): void;
    end(body?: string): void;
  }) => void): Promise<string> {
    const http = await import('node:http');
    server = http.createServer(handler as never);
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
    const address = server!.address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  }

  it('finds the project t3code already holds for this workspace root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'air-219-lookup-'));
    try {
      const base = await serve((_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          projects: [
            { id: 'other', workspaceRoot: '/somewhere/else' },
            { id: 'p-existing', workspaceRoot: root },
          ],
          threads: [],
        }));
      });
      expect(await activeProjectForWorkspace(base, 'tok', root))
        .toEqual({ kind: 'found', projectId: 'p-existing' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `/var` and `/private/var` are the same directory on macOS, and `mkdtempSync`
   * hands out the first while `realpath` gives the second. A string compare calls
   * them different and answers `none` for a project that exists — straight back into
   * the invariant this lookup exists to avoid.
   */
  it('matches a workspace root that differs only by symlink resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'air-219-symlink-'));
    try {
      const { realpathSync } = await import('node:fs');
      const resolved = realpathSync(root);
      // Only meaningful when the platform actually resolves it differently.
      const stored = resolved === root ? root : resolved;
      const base = await serve((_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ projects: [{ id: 'p1', workspaceRoot: stored }], threads: [] }));
      });
      expect(await activeProjectForWorkspace(base, 'tok', root))
        .toEqual({ kind: 'found', projectId: 'p1' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers `none` when the server holds no project for that root', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ projects: [{ id: 'p1', workspaceRoot: '/elsewhere' }], threads: [] }));
    });
    expect(await activeProjectForWorkspace(base, 'tok', '/nothing/here')).toEqual({ kind: 'none' });
  });

  /**
   * The third answer, and the reason there are three. `unknown` leads the caller to a
   * different move than `none` does — on `none` it creates a project, which is exactly
   * what fails when the truth was "I could not tell".
   */
  it('a refused lookup is `unknown`, never `none`', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 503;
      res.end('nope');
    });
    const lookup = await activeProjectForWorkspace(base, 'tok', '/ws');
    expect(lookup.kind).toBe('unknown');
    expect(lookup.kind === 'unknown' && lookup.detail).toContain('503');
  });

  it('an unreachable server is `unknown`, never `none`', async () => {
    // Port 1 on loopback: nothing listens, and connecting fails immediately.
    const lookup = await activeProjectForWorkspace('http://127.0.0.1:1', 'tok', '/ws');
    expect(lookup.kind).toBe('unknown');
  });

  it('a response with no projects array is `unknown`, never `none`', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ threads: [] }));
    });
    const lookup = await activeProjectForWorkspace(base, 'tok', '/ws');
    expect(lookup.kind).toBe('unknown');
    expect(lookup.kind === 'unknown' && lookup.detail).toContain('no projects array');
  });
});

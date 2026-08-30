/**
 * Criteria 7, 8, 9b and 15, against two live servers.
 *
 * Every assertion here is about a running system: two `codev-agent` hosts, two
 * real workspaces on disk, the built client served as a static bundle, and
 * porch's own `approve` writing a real `status.yaml`. One host is killed and one
 * credential is really revoked, because a single-server approximation of either
 * is not evidence.
 */
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error — the harness is plain ESM on purpose; it carries no types.
import { cleanupScratch, makeWorkspace, readStatus, serveClient, startHost } from './fixture.mjs';

const GATE = {
  question: 'Ship the porch driver behind a flag?',
  choices: [
    { label: 'Behind a flag', consequence: 'Existing workspaces are untouched', recommended: true },
    { label: 'On by default', consequence: 'Every workspace picks it up at once' },
  ],
};

// Ephemeral, because a fixed port is a promise about a machine this test does
// not own. Each host reports the port it actually bound.
const EPHEMERAL = 0;

interface Machine {
  workspace: any;
  host: any;
  entry: Record<string, unknown>;
}

let alpha: Machine;
let beta: Machine;
let staticServer: any;
let clientOrigin: string;
let visible: Array<Record<string, unknown>> = [];

async function stand(
  label: string,
  gate: unknown,
  options: { skipChecks?: boolean; passingChecks?: boolean; breakCommit?: boolean } = {},
): Promise<Machine> {
  const workspace = makeWorkspace(label, gate, options);
  const host = await startHost({ port: EPHEMERAL, workspace, machine: label });
  return {
    workspace,
    host,
    entry: {
      id: label,
      label,
      origin: `http://127.0.0.1:${host.port}`,
      workspacePath: host.workspacePath,
      credential: host.credential,
    },
  };
}

test.beforeAll(async () => {
  alpha = await stand('alpha', GATE);
  beta = await stand('beta', null);
  staticServer = await serveClient(EPHEMERAL, () => visible);
  clientOrigin = `http://127.0.0.1:${staticServer.address().port}`;
});

test.afterAll(async () => {
  await alpha?.host.stop().catch(() => {});
  await beta?.host.stop().catch(() => {});
  await staticServer?.shutdown();
  cleanupScratch();
});

/**
 * Open the client. The fixture's own server proxies `/m/<id>/` to each host, so
 * the page reaches every machine same-origin — the shape the dev server uses,
 * and the one `connect-src 'self'` permits.
 */
async function openClient(page: Page): Promise<void> {
  await page.goto(`${clientOrigin}/client/`);
}

/** Which machines the served `machines.json` announces on the next load. */
function announce(...entries: Array<Record<string, unknown>>): void {
  visible = entries;
}

test.describe('two machines, independently live', () => {
  test('criterion 7: both subtrees render their own rows and both are live', async ({ page }) => {
    announce(alpha.entry, beta.entry);
    await openClient(page);

    await expect(page.locator('[data-machine="alpha"] .conn-live')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-machine="beta"] .conn-live')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator('[data-machine="alpha"] [data-id="builder-alpha-gated"]')).toBeVisible();
    await expect(page.locator('[data-machine="beta"] [data-id="builder-beta-gated"]')).toBeVisible();
    // Each machine shows only its own rows.
    await expect(page.locator('[data-machine="alpha"] [data-id="builder-beta-gated"]')).toHaveCount(0);
    await expect(page.locator('[data-machine="alpha"] .architect-group')).toHaveCount(1);
  });

  test('criterion 3: the blocked builder shows its question and choices in the row', async ({ page }) => {
    announce(alpha.entry, beta.entry);
    await openClient(page);
    const row = page.locator('[data-machine="alpha"] [data-id="builder-alpha-gated"]');
    await expect(row).toBeVisible({ timeout: 30_000 });

    await expect(row.locator('.status-stamp')).toHaveText('GATE PR');
    await expect(row.locator('.gate-question')).toHaveText(GATE.question);
    await expect(row.locator('.gate-choices li')).toHaveCount(2);
    await expect(row.locator('.gate-choices li.is-recommended .choice-label')).toHaveText('Behind a flag');
    await expect(row.locator('.gate-choices li').first()).toContainText('Existing workspaces are untouched');

    // A builder with no requested gate is not blocked, and looks different.
    const quiet = page.locator('[data-machine="alpha"] [data-id="builder-alpha-quiet"]');
    await expect(quiet).toHaveAttribute('data-status', /^(?!blocked).*/);
    await expect(quiet.locator('.gate-panel')).toHaveCount(0);
  });
});

test.describe('honest degradation', () => {
  test('criterion 8: one server stopped, its subtree is dated and the other stays live', async ({ page }) => {
    announce(alpha.entry, beta.entry);
    await openClient(page);
    await expect(page.locator('[data-machine="beta"] .conn-live')).toBeVisible({ timeout: 30_000 });

    await beta.host.stop();

    const band = page.locator('[data-machine="beta"] .conn-down');
    await expect(band).toBeVisible({ timeout: 60_000 });
    await expect(band).toContainText('DISCONNECTED');
    // The timestamp is what makes last-known distinguishable from current.
    await expect(band).toContainText(/last live .* ago · \d{4}-\d{2}-\d{2}T/);
    await expect(page.locator('[data-machine="beta"] .stale-note')).toContainText('It is not current.');
    // Not blank: the rows it had are still there.
    await expect(page.locator('[data-machine="beta"] .thread-row')).toHaveCount(3);

    // Alpha is untouched.
    await expect(page.locator('[data-machine="alpha"] .conn-live')).toBeVisible();
    await expect(page.locator('[data-machine="alpha"] .conn-down')).toHaveCount(0);
  });

});

test.describe('approving a real gate', () => {
  test('criterion 9b and 15: approve on alpha, then revoke alpha and fail it closed', async ({ page }) => {
    announce(alpha.entry);
    await openClient(page);
    const row = page.locator('[data-machine="alpha"] [data-id="builder-alpha-gated"]');
    await expect(row.locator('.gate-panel')).toBeVisible({ timeout: 30_000 });

    // A human session costs a fresh pairing token; the client asks for one.
    await expect(row.locator('.gate-token')).toBeVisible();
    const token = await mintPairingToken();
    await row.locator('.gate-token').fill(token);
    await row.getByRole('button', { name: /open a session/i }).click();

    const approveButton = row.getByRole('button', { name: /approve pr/i });
    await expect(approveButton).toBeVisible({ timeout: 20_000 });
    await approveButton.click();
    await expect(row.locator('.gate-result.is-ok')).toBeVisible({ timeout: 30_000 });
    // The gate is gone from the row, and the confirmation outlived it.
    await expect(row.locator('.gate-panel')).toHaveCount(0);

    // CRITERION 9b: porch wrote it, with session id, machine and timestamp.
    const gated = alpha.workspace.builders.find((b: any) => b.projectId === 'alpha-gated');
    const status = readStatus(gated.statusPath);
    expect(status).toContain('status: approved');
    expect(status).toContain('authorization: capability');
    expect(status).toContain('machine: alpha');
    expect(status).toMatch(/session_id: [0-9a-f-]{36}/);
    expect(status).toMatch(/approved_at: '?\d{4}-\d{2}-\d{2}T/);

    // CRITERION 15: revoke this machine and the subtree fails closed, as a
    // revocation and not as a generic disconnect.
    await alpha.host.revoke();
    const revoked = page.locator('[data-machine="alpha"] .conn-revoked');
    await expect(revoked).toBeVisible({ timeout: 60_000 });
    await expect(revoked).toContainText('ACCESS REVOKED');
    await expect(revoked).toContainText('not retrying');
    await expect(revoked).toContainText('MACHINE_CREDENTIAL_REVOKED');
    await expect(page.locator('[data-machine="alpha"] .conn-down')).toHaveCount(0);
  });

  /*
   * A COMMIT THAT FAILS AFTER THE GATE IS ALREADY ON DISK.
   *
   * `writeState` runs before `git add`, so a failing pre-commit hook leaves
   * `status.yaml` saying approved and the change out of git. Reported as a
   * refusal, the human approves again; and this is the ONLY place in the repo
   * where the failure can be produced at all, because `writeStateAndCommit`
   * skips git under VITEST and the host here is a real child process.
   */
  test('reports an approval whose commit failed as approved, with the remedy', async ({ page }) => {
    const broken = await stand('commitfail', GATE, { breakCommit: true });
    try {
      announce(broken.entry);
      await openClient(page);
      const row = page.locator('[data-machine="commitfail"] [data-id="builder-commitfail-gated"]');
      await expect(row.locator('.gate-panel')).toBeVisible({ timeout: 30_000 });

      await row.locator('.gate-token').fill(
        await mintPairingTokenFor(broken.host.stateRoot as string),
      );
      await row.getByRole('button', { name: /open a session/i }).click();
      const approveButton = row.getByRole('button', { name: /approve pr/i });
      await expect(approveButton).toBeVisible({ timeout: 20_000 });
      await approveButton.click();

      // A SUCCESS carrying a caveat, not a refusal.
      const result = row.locator('.gate-result.is-ok');
      await expect(result).toBeVisible({ timeout: 30_000 });
      await expect(result).toContainText('NOT committed');
      await expect(result).toContainText('Do not approve again');
      await expect(row.locator('.gate-result.is-refused')).toHaveCount(0);

      // And the gate really is approved on disk, which is why the caveat is right.
      const project = broken.workspace.builders.find((b: any) => b.projectId === 'commitfail-gated');
      expect(readStatus(project.statusPath)).toContain('status: approved');
    } finally {
      await broken.host.stop().catch(() => {});
    }
  });

  /*
   * THE SYNCHRONOUS ROUTE STILL REFUSES — SPEC 146 CRITERION 11.
   *
   * This test used to drive the refusal through the UI. Spec 236 gave the panel
   * an asynchronous path, so the UI no longer reaches this branch — and DELETING
   * the assertion would have removed the only end-to-end proof that an HTTP
   * request never runs a repository's build. So it drives the synchronous route
   * DIRECTLY instead, and the UI's new behaviour is asserted in the test below.
   *
   * The refusal is not a limitation being worked around: an unbounded build on an
   * open connection is the thing it exists to prevent, and a request timeout was
   * never the alternative, because a client that gives up does not stop porch.
   */
  test('the synchronous route refuses, rather than running a build inside the request', async () => {
    const gated = await stand('checks', GATE, { skipChecks: false });
    try {
      const origin = `http://127.0.0.1:${gated.host.port}`;
      const authed = await sessionHeadersFor(gated, origin);
      const capability = await postJson(`${origin}/api/agent/v1/approval-capabilities`, authed,
        { principalKind: 'human-client' });
      const nonce = await postJson(`${origin}/api/agent/v1/approval-nonces`, authed, {
        projectId: 'checks-gated', gateName: 'pr', capabilityId: capability.body.capabilityId,
      });
      const workspace = Buffer.from(gated.host.workspacePath as string, 'utf8').toString('base64url');

      const refused = await postJson(
        `${origin}/api/agent/v1/workspaces/${workspace}/gates/approve`, authed,
        {
          projectId: 'checks-gated',
          gateName: 'pr',
          capability: capability.body.presentation,
          nonce: nonce.body.nonce,
        },
      );
      expect(refused.status).toBe(403);
      expect(refused.body.signal).toBe('PHASE_CHECKS_REQUIRED');
      expect(String(refused.body.message)).toContain('build');

      // And the gate is still pending, because nothing ran.
      const project = gated.workspace.builders.find((b: any) => b.projectId === 'checks-gated');
      expect(readStatus(project.statusPath)).toContain('status: pending');
    } finally {
      await gated.host.stop().catch(() => {});
    }
  });

  /*
   * AND THE ASYNCHRONOUS PATH APPROVES IT — SPEC 146 CRITERION 7, FROM THE UI.
   *
   * The phase declares checks, so the route above refuses the very same project.
   * Here the panel submits, shows what is running, and reports the approval when
   * the checks pass. A success proven on a workspace with the checks REMOVED
   * would be the path that already worked before any of this.
   */
  test('approves a checks-enabled project from the client, showing what it is running', async ({ page }) => {
    const gated = await stand('async', GATE, { passingChecks: true });
    try {
      announce(gated.entry);
      await openClient(page);
      const row = page.locator('[data-machine="async"] [data-id="builder-async-gated"]');
      await expect(row.locator('.gate-panel')).toBeVisible({ timeout: 30_000 });

      await row.locator('.gate-token').fill(
        await mintPairingTokenFor(gated.host.stateRoot as string),
      );
      await row.getByRole('button', { name: /open a session/i }).click();
      const approveButton = row.getByRole('button', { name: /approve pr/i });
      await expect(approveButton).toBeVisible({ timeout: 20_000 });
      await approveButton.click();

      // SOMETHING SPECIFIC IMMEDIATELY, rather than a bare spinner: even before
      // the first poll the panel says the submit was accepted and it is waiting.
      await expect(row.locator('.gate-progress')).toBeVisible({ timeout: 30_000 });

      // AND THEN THE SERVER'S OWN CHECK NAMES. The stand's checks take two
      // seconds, longer than the one-second poll interval, so the running frame
      // is reached by construction — with instant checks the approval settles
      // before the first poll and this assertion would be testing scheduling.
      await expect(row.locator('.gate-progress')).toContainText(/build|tests/, { timeout: 60_000 });

      const result = row.locator('.gate-result');
      await expect(result).toBeVisible({ timeout: 120_000 });
      await expect(result).not.toHaveClass(/is-refused/);

      const project = gated.workspace.builders.find((b: any) => b.projectId === 'async-gated');
      expect(readStatus(project.statusPath)).toContain('status: approved');
    } finally {
      await gated.host.stop().catch(() => {});
    }
  });
});

/** POST JSON and read the answer, for the tests that drive a route directly. */
async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

/** Pair and open a session on one stand, returning the headers both need. */
async function sessionHeadersFor(machine: Machine, origin: string): Promise<Record<string, string>> {
  const session = await postJson(`${origin}/api/agent/v1/human-sessions`, {
    'x-codev-machine-credential': machine.host.credential as string,
    'x-codev-pairing-token': await mintPairingTokenFor(machine.host.stateRoot as string),
  }, {});
  return {
    'x-codev-machine-credential': machine.host.credential as string,
    'x-codev-human-session': session.body.presentation as string,
  };
}

/** Mint a token the way an operator does: on the host, out of band. */
async function mintPairingToken(): Promise<string> {
  return mintPairingTokenFor(alpha.host.stateRoot as string);
}

async function mintPairingTokenFor(stateRoot: string): Promise<string> {
  const { PairingStore } = await import(
    '../../../packages/codev/src/agent-farm/lib/pairing.js'
  );
  return new PairingStore({ root: `${stateRoot}/pairing` }).issue({ purpose: 'client-session', authority: 'e2e harness' }).token;
}

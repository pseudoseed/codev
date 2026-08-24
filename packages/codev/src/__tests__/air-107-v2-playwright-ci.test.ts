/**
 * Issue #107 — apps/v2 Playwright must run in the root Tests workflow.
 *
 * Spec 83 landed a same-origin fixture suite (`apps/v2` `pnpm test:e2e`,
 * 127.0.0.1:4173). Vitest is already in the unit job. Playwright was not in
 * any job, so a broken site view stayed green on CI.
 *
 * This test pins the workflow contract: a dedicated job runs that local
 * command against the fixture, does not start Tower, and does not pass
 * `--with-deps` to the Chromium install (#1502).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
  'working-directory'?: string;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf-8')) as Workflow;

function v2PlaywrightJob(): [string, WorkflowJob] {
  const match = Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some(
      (step) =>
        step['working-directory'] === 'apps/v2' &&
        typeof step.run === 'string' &&
        (step.run.includes('test:e2e') || step.run.includes('playwright test')),
    ),
  );
  expect(match, 'test.yml must have a job that runs apps/v2 Playwright').toBeDefined();
  return match!;
}

describe('air-107: apps/v2 Playwright is in the Tests workflow', () => {
  it('runs the local e2e script from apps/v2', () => {
    const [, job] = v2PlaywrightJob();
    const runStep = (job.steps ?? []).find(
      (step) =>
        step['working-directory'] === 'apps/v2' &&
        typeof step.run === 'string' &&
        (step.run.includes('test:e2e') || step.run.includes('playwright test')),
    );
    expect(runStep?.run).toContain('test:e2e');
    expect(runStep?.['working-directory']).toBe('apps/v2');
  });

  it('does not start Tower', () => {
    const [, job] = v2PlaywrightJob();
    for (const step of job.steps ?? []) {
      const run = step.run ?? '';
      expect(run).not.toMatch(/\bafx\b/);
      expect(run).not.toMatch(/\btower\b/i);
      expect(run).not.toContain('TOWER_');
    }
  });

  it('installs Chromium without --with-deps', () => {
    const [, job] = v2PlaywrightJob();
    const installStep = (job.steps ?? []).find((step) =>
      step.run?.includes('playwright install'),
    );
    expect(installStep, 'v2 Playwright job must install Chromium').toBeDefined();
    expect(installStep?.['working-directory']).toBe('apps/v2');
    expect(installStep?.run).not.toContain('--with-deps');
  });
});

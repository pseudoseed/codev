/**
 * Regression test for bugfix #181: unit tests that import porch-driver/dist
 * must find that directory in CI.
 *
 * `porch-thread-engine.ts` imports `packages/porch-driver/dist/*.js`. That
 * directory is gitignored, and the unit job used to build types and
 * artifact-canvas but never porch-driver. A fresh CI checkout then failed
 * with ERR_MODULE_NOT_FOUND; a local worktree with a leftover dist/ stayed
 * green.
 *
 * This pins the contract: the unit job builds porch-driver before it copies
 * the skeleton and runs vitest.
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
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf-8')) as Workflow;

function stepIndex(
  steps: WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
): number {
  return steps.findIndex(predicate);
}

describe('bugfix-181: unit job builds porch-driver before codev tests', () => {
  it('has a unit job', () => {
    expect(workflow.jobs).toHaveProperty('unit');
  });

  it('builds porch-driver before copy-skeleton and vitest', () => {
    const steps = workflow.jobs.unit.steps ?? [];
    const buildIndex = stepIndex(
      steps,
      (step) =>
        step['working-directory'] === 'packages/porch-driver' &&
        typeof step.run === 'string' &&
        step.run.includes('pnpm build'),
    );
    const copyIndex = stepIndex(
      steps,
      (step) =>
        step['working-directory'] === 'packages/codev' &&
        typeof step.run === 'string' &&
        step.run.includes('copy-skeleton'),
    );
    const vitestIndex = stepIndex(
      steps,
      (step) =>
        step['working-directory'] === 'packages/codev' &&
        typeof step.run === 'string' &&
        step.run.includes('vitest run'),
    );

    expect(
      buildIndex,
      'unit job must build packages/porch-driver (see #181)',
    ).toBeGreaterThanOrEqual(0);
    expect(copyIndex, 'unit job must copy-skeleton for codev tests').toBeGreaterThanOrEqual(0);
    expect(vitestIndex, 'unit job must run codev vitest').toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(copyIndex);
    expect(buildIndex).toBeLessThan(vitestIndex);
  });
});

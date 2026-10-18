import { correlationId } from '@atolis-hq/eventing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import { isActiveRunStatus, RunStatus } from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';
import { defineScenario } from '../support/scenario.js';

defineScenario(
  {
    id: 'E2E-ORCH-DELEGATION-001',
    title: 'a delegated tree finishes across restart with one open-work slot and one Run slot',
    given: ['a real filesystem home and production composition with a permanent scripted runner'],
    when: ['a Run submits child work and the host restarts while the parent waits'],
    then: ['the child and parent complete before an unrelated root can start'],
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'wake-delivery-capacity-'));
    const runner = new ScriptedDelegationRunner();
    const stage = {
      activity: 'agent',
      with: { prompt: 'Complete the assignment' },
      requiresApproval: false,
      execution: { workspace: 'none' },
      on: { done: { then: 'done' } },
    };
    const config = parseRootConfig({
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      controlPlane: { maxConcurrentRuns: 1, maxOpenWorkItems: 1, maxDispatches: 1 },
      orchestration: {
        default: 'parent',
        workflows: {
          parent: {
            delegation: {
              workflows: ['child'],
              maxDepth: 2,
              maxDescendants: 4,
              maxConcurrentRuns: 1,
            },
            stages: { delegate: stage },
          },
          child: { stages: { inspect: stage } },
        },
      },
    });
    const context = (commandId: string) => ({
      commandId,
      correlationId: correlationId('delivery-e2e'),
      occurredAt: new Date().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    });
    const open = () => createCompositionRoot(home, { config, decorateRunner: () => runner });
    try {
      let root = await open();
      const parentWork = workId('e2e-parent');
      const unrelatedWork = workId('e2e-unrelated');
      for (const id of [parentWork, unrelatedWork])
        await root.work.create(
          { workItemId: id, objective: 'Investigate' },
          context('create-' + id),
        );
      const parent = await root.orchestration.start(
        {
          workItemId: parentWork,
          workflowInstanceId: workflowInstanceId('parent'),
          workflowName: workflowName('parent'),
          orchestrationGroupId: orchestrationGroupId('parent'),
        },
        context('start-parent'),
      );
      const unrelated = await root.orchestration.start(
        {
          workItemId: unrelatedWork,
          workflowInstanceId: workflowInstanceId('unrelated'),
          workflowName: workflowName('child'),
          orchestrationGroupId: orchestrationGroupId('unrelated'),
        },
        context('start-unrelated'),
      );
      let childId: ReturnType<typeof workflowInstanceId> | undefined;
      runner.scripts.push(async (request) => {
        const reservation = await root.orchestration.submitDelegation(
          {
            workflowInstanceId: parent.workflowInstanceId,
            activationId: parent.pendingActivation!.activationId,
            runId: request.runId,
          },
          {
            cohortId: 'delivery',
            assignments: [
              {
                assignmentId: 'inspect',
                objective: 'Inspect child',
                criteria: ['Publish findings'],
                workflowName: workflowName('child'),
                context: [],
                outputs: [{ name: 'findings', path: 'findings.md' }],
              },
            ],
          },
          context('submit'),
        );
        childId = reservation.children[0]!.workflowInstanceId;
        return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
      });
      await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await vi.waitFor(async () => {
        const runs = await root.execution.list();
        expect(runs.length).toBe(1);
        expect(runs.every((run) => !isActiveRunStatus(run.status))).toBe(true);
      });
      expect(childId).toBeDefined();
      root = await open();
      const child = (await root.orchestration.get(childId!))!;
      expect((await root.work.get(child.workItemId))!.delegation?.rootWorkItemId).toBe(parentWork);
      await root.orchestration.listPendingActivations(child.workItemId);
      const operator = await open();
      await operator.work.freeze(parentWork, context('freeze-from-another-host'));
      expect(await root.orchestration.listPendingActivations(child.workItemId)).toHaveLength(0);
      expect(
        await root.orchestration.validateActivationDispatch(
          child.workflowInstanceId,
          context('late-dispatch'),
        ),
      ).toBe(false);
      await operator.work.unfreeze(parentWork, context('unfreeze-from-another-host'));
      runner.scripts.push(async (request) => {
        await root.artifacts.stageRevision(
          {
            revisionId: 'findings',
            path: 'findings.md',
            bytes: new TextEncoder().encode('Findings'),
          },
          {
            workItemId: child.workItemId,
            producer: child.workflowInstanceId + '/inspect',
            activationId: child.pendingActivation!.activationId,
            runId: request.runId,
          },
          context('publish'),
        );
        return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
      });
      runner.scripts.push(async () => {
        expect(
          await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'delivery'),
        ).toHaveLength(1);
        return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
      });
      for (let pass = 0; pass < 12; pass++) {
        await root.advanceOnce({ maxProgress: 1 });
        await vi.waitFor(async () =>
          expect((await root.execution.list()).every((run) => !isActiveRunStatus(run.status))).toBe(
            true,
          ),
        );
        expect(
          (await root.execution.list()).some(
            (run) => run.workflowInstanceId === unrelated.workflowInstanceId,
          ),
        ).toBe(false);
        if ((await root.orchestration.get(parent.workflowInstanceId))!.status === 'completed')
          break;
      }
      expect((await root.orchestration.get(childId!))!.status).toBe('completed');
      expect((await root.orchestration.get(parent.workflowInstanceId))!.status).toBe('completed');
      expect(runner.requests).toHaveLength(3);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

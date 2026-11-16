import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  boardProjection,
  createCompositionRoot,
  parseRootConfig,
  type BoardProjectionView,
} from '../../../src/bootstrap/index.js';
import { isActiveRunStatus, RunStatus } from '../../../src/execution/index.js';
import {
  createOrchestrationEventData,
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
  type DelegationReservation,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

it('replaces all three children after a failed stack settles, including two that never started', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-replacement-'));
  const context = (commandId: string) => ({
    commandId,
    correlationId: correlationId('replacement'),
    occurredAt: new Date().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  });
  try {
    const runner = new ScriptedDelegationRunner();
    const stage = {
      activity: 'agent',
      with: { prompt: 'Perform assignment' },
      execution: { workspace: 'none' },
      requiresApproval: false,
      on: { done: { then: 'done' }, failed: { then: 'done' } },
    };
    const root = await createCompositionRoot(home, {
      config: parseRootConfig({
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: {
          default: 'parent',
          workflows: {
            parent: {
              delegation: {
                workflows: ['child'],
                maxDepth: 1,
                maxDescendants: 6,
                maxConcurrentRuns: 1,
              },
              stages: { work: stage },
            },
            child: { stages: { work: stage } },
          },
        },
      }),
      journal: new InMemoryEventJournal({ now: () => new Date() }),
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
      decorateRunner: () => runner,
    });
    const parentWork = workId('queued-replacement');
    await root.work.create(
      { workItemId: parentWork, objective: 'Deliver stack' },
      context('create'),
    );
    const parent = await root.orchestration.start(
      {
        workItemId: parentWork,
        workflowInstanceId: workflowInstanceId('queued-replacement'),
        workflowName: workflowName('parent'),
        orchestrationGroupId: orchestrationGroupId('queued-replacement'),
      },
      context('start'),
    );
    const assignments = ['one', 'two', 'three'].map((id, index, ids) => ({
      assignmentId: id,
      objective: 'Deliver ' + id,
      criteria: ['Acceptance for ' + id],
      workflowName: workflowName('child'),
      context: [],
      outputs: [{ name: 'report', path: 'report.md' }],
      prerequisites:
        index === 0
          ? []
          : [
              {
                assignmentId: ids[index - 1]!,
                output: 'report',
                condition: 'accepted-output' as const,
              },
            ],
    }));
    const replacements = assignments.map((assignment) => ({
      ...assignment,
      assignmentId: assignment.assignmentId + '-repair',
      replaces: { cohortId: 'original', assignmentId: assignment.assignmentId },
      prerequisites: assignment.prerequisites.map((entry) => ({
        ...entry,
        assignmentId: entry.assignmentId + '-repair',
      })),
    }));
    let original!: DelegationReservation;
    let repaired: DelegationReservation | undefined;
    runner.scripts.push(async (request) => {
      const caller = {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: request.runId,
      };
      original = await root.orchestration.submitDelegation(
        caller,
        {
          cohortId: 'original',
          assignments,
        },
        context('reserve'),
      );
      await expect(
        root.orchestration.submitDelegation(
          caller,
          {
            cohortId: 'live-repair',
            assignments: [replacements[0]!],
          },
          context('live'),
        ),
      ).rejects.toMatchObject({
        code: 'replacement-unsupported',
        message: expect.stringContaining('still running'),
      });
      await expect(
        root.orchestration.submitDelegation(
          caller,
          {
            cohortId: 'missing-repair',
            assignments: [{ ...replacements[2]!, prerequisites: [] }],
          },
          context('missing'),
        ),
      ).rejects.toMatchObject({
        code: 'replacement-unsupported',
        message: expect.stringContaining('instance is missing'),
      });
      return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
    });
    const awaitRuns = async () =>
      vi.waitFor(async () => {
        expect((await root.execution.list()).every((run) => !isActiveRunStatus(run.status))).toBe(
          true,
        );
      });
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await awaitRuns();
    expect(original.children).toHaveLength(3);
    for (const child of original.children.slice(1))
      expect(await root.orchestration.get(child.workflowInstanceId)).toBeNull();
    runner.scripts.push(async () => ({
      transport: RunStatus.Succeeded,
      runner: 'fake',
      output: '{"status":"FAILED"}',
    }));
    await root.advanceOnce({ workItemId: original.children[0]!.workItemId, maxProgress: 1 });
    await awaitRuns();
    const childRun = (await root.execution.list()).find(
      (run) => run.workflowInstanceId === original.children[0]!.workflowInstanceId,
    )!;
    await root.orchestration.acceptOutcome(
      {
        workflowInstanceId: childRun.workflowInstanceId,
        activationId: childRun.activationId,
        outcome: childRun.outcome!,
      },
      context('accept-child'),
    );
    await root.orchestration.reconcileChildCompletions(context('settle'));
    for (const child of original.children.slice(1))
      expect(await root.orchestration.get(child.workflowInstanceId)).toBeNull();
    const retiredStream = workflowInstanceStream(original.children[0]!.workflowInstanceId);
    await root.journal.appendToStream(
      retiredStream,
      (await root.journal.readStream(retiredStream)).length,
      [
        createOrchestrationEventData({
          ...context('supersede'),
          eventId: 'superseded-original',
          causationId: 'test',
          source: { kind: 'internal', id: 'test' },
          eventType: OrchestrationEventType.InstanceSuperseded,
          payload: {},
        }),
      ],
    );
    runner.scripts.push(async (request) => {
      const resumed = (await root.orchestration.get(parent.workflowInstanceId))!;
      repaired = await root.orchestration.submitDelegation(
        {
          workflowInstanceId: resumed.workflowInstanceId,
          activationId: resumed.pendingActivation!.activationId,
          runId: request.runId,
        },
        { cohortId: 'repair', assignments: replacements },
        context('repair'),
      );
      return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
    });
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await awaitRuns();
    expect(repaired?.children).toHaveLength(3);
    await root.projectionSubscriptions.catchUpOnce();
    const board = (await root.projections.read<BoardProjectionView>(
      boardProjection.name,
      'global',
    ))!.value;
    for (const child of original.children) {
      expect(board.cards[child.workItemId]!.prerequisiteWait).toBeUndefined();
    }
    expect(board.cards[original.children[0]!.workItemId]).toMatchObject({
      condition: 'finished',
      superseded: true,
    });
    for (const child of repaired!.children.slice(1)) {
      expect(board.cards[child.workItemId]).toMatchObject({
        condition: 'ready',
        prerequisiteWait: {
          reason: expect.stringContaining('Waiting for upstream'),
          prerequisites: child.prerequisites!.map(({ assignmentId, output, condition }) => ({
            assignmentId,
            output,
            condition,
          })),
        },
      });
    }
    expect(repaired!.children.map((child) => child.criteria)).toEqual(
      original.children.map((child) => child.criteria),
    );
    expect(repaired!.children.map((child) => child.repository)).toEqual(
      original.children.map((child) => child.repository),
    );
    expect((await root.execution.list()).every((run) => run.status === RunStatus.Succeeded)).toBe(
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

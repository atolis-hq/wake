import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  boardProjection,
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
  type BoardProjectionView,
} from '../../../src/bootstrap/index.js';
import { isActiveRunStatus, RunStatus } from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  WorkflowStatus,
  type DelegationReservation,
} from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

it.each([WorkflowStatus.Completed, WorkflowStatus.Superseded])(
  'replaces a settled stack with a %s upstream and two children that never started',
  async (status) => {
    const home = await mkdtemp(join(tmpdir(), 'wake-replacement-'));
    const context = (commandId: string) => ({
      commandId,
      correlationId: correlationId('replacement'),
      occurredAt: new Date().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    });
    try {
      await mkdir(join(home, 'prompts'));
      await writeFile(join(home, 'prompts', 'assignment.md'), '---\n{}\n---\nPerform assignment');
      const runner = new ScriptedDelegationRunner();
      const stage = {
        activity: 'agent',
        with: { template: 'assignment' },
        execution: { workspace: 'none' },
        requiresApproval: false,
        on: { done: { then: 'done' }, failed: { then: 'done' } },
      };
      const root = await createCompositionRoot(home, {
        config: parseRootConfig({
          surfaces: { api: { conversationMessages: { enabled: true } } },
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
      const originalChild = original.children[0]!;
      expect((await root.orchestration.get(originalChild.workflowInstanceId))!.status).toBe(
        WorkflowStatus.Active,
      );
      const instruction = '/changes Re-assess the stack after the upstream base moved.';
      const command = {
        body: instruction,
        actorId: 'maintainer',
        capabilities: ['operator-surface' as const],
        authorized: false,
        reviewAuthorized: false,
      };
      expect(
        await root.orchestration.applyConversationCommandWithFeedback(
          parentWork,
          command,
          context('unauthorized-assessment'),
        ),
      ).toMatchObject({ applied: false });
      expect(
        (await root.orchestration.get(parent.workflowInstanceId))!.delegationAttention,
      ).toBeUndefined();
      await root.projectionSubscriptions.catchUpOnce();
      const applications = await createSurfaceApplications(root);
      const key = toWorkItemKey(parentWork);
      expect((await applications.api.work.detail(key))!.data.conversation.canContinue).toBe(true);
      expect(
        await applications.api.work.message!(key, {
          idempotencyKey: 'operator-assessment',
          body: instruction,
          continuation: true,
        }),
      ).toMatchObject({ status: 'accepted' });
      const attending = (await root.orchestration.get(parent.workflowInstanceId))!;
      expect(attending.delegationAttention).toBeDefined();
      expect(
        await root.orchestration.applyConversationCommandWithFeedback(
          parentWork,
          { ...command, authorized: true },
          context('second-assessment'),
        ),
      ).toMatchObject({ applied: false });
      runner.scripts.push(async (request) => {
        expect(request.prompt).toContain(instruction);
        const caller = {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: attending.pendingActivation!.activationId,
          runId: request.runId,
        };
        expect(
          (await root.orchestration.inspectDelegation(caller, context('assess-inspect'))).tree,
        ).toHaveLength(1);
        await expect(
          root.orchestration.submitDelegation(
            caller,
            {
              cohortId: 'premature-repair',
              assignments: replacements,
            },
            context('assess-replace'),
          ),
        ).rejects.toMatchObject({ code: 'replacement-unsupported' });
        return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
      });
      await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await awaitRuns();
      const assessmentRun = (await root.execution.list()).find(
        (run) => run.activationId === attending.pendingActivation!.activationId,
      )!;
      expect(assessmentRun.failure).toBeUndefined();
      expect(assessmentRun.outcome).toMatchObject({ kind: 'done' });
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: assessmentRun.activationId,
          outcome: assessmentRun.outcome!,
        },
        context('accept-assessment'),
      );
      await root.orchestration.reconcileChildCompletions(context('restore-assessment-wait'));
      const restored = (await root.orchestration.get(parent.workflowInstanceId))!;
      expect(restored.delegationAttention).toBeUndefined();
      expect(restored.delegationWait?.cohortId).toBe('original');
      await root.projectionSubscriptions.catchUpOnce();
      expect((await applications.api.work.detail(key))!.data.conversation.canContinue).toBe(true);
      expect(restored.operatorRetryCommandIds).toContain('work:operator-assessment');
      expect(
        await root.orchestration.applyConversationCommandWithFeedback(
          parentWork,
          { ...command, authorized: true },
          context('work:operator-assessment'),
        ),
      ).toMatchObject({ applied: true });
      expect(
        await applications.api.work.message!(key, {
          idempotencyKey: 'operator-assessment',
          body: instruction,
          continuation: true,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(
        (await root.orchestration.get(parent.workflowInstanceId))!.delegationAttention,
      ).toBeUndefined();
      if (status === WorkflowStatus.Superseded) {
        // Settlement abandons the live instance after its assignment is withdrawn.
        await root.work.cancel(
          originalChild.workItemId,
          'Upstream assignment withdrawn',
          context('cancel-upstream'),
        );
      } else {
        runner.scripts.push(async () => ({
          transport: RunStatus.Succeeded,
          runner: 'fake',
          output: '{"status":"FAILED"}',
        }));
        await root.advanceOnce({ workItemId: originalChild.workItemId, maxProgress: 1 });
        await awaitRuns();
        const childRun = (await root.execution.list()).find(
          (run) => run.workflowInstanceId === originalChild.workflowInstanceId,
        )!;
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: childRun.workflowInstanceId,
            activationId: childRun.activationId,
            outcome: childRun.outcome!,
          },
          context('accept-child'),
        );
      }
      await root.orchestration.reconcileChildCompletions(context('settle'));
      expect(
        await root.orchestration.applyConversationCommandWithFeedback(
          parentWork,
          { ...command, authorized: true },
          context('stale-assessment'),
        ),
      ).toMatchObject({ applied: false, reason: expect.stringContaining('No eligible') });
      expect((await root.orchestration.get(originalChild.workflowInstanceId))!.status).toBe(status);
      for (const child of original.children.slice(1))
        expect(await root.orchestration.get(child.workflowInstanceId)).toBeNull();
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
      });
      expect(board.cards[originalChild.workItemId]!.superseded).toBe(
        status === WorkflowStatus.Superseded ? true : undefined,
      );
      // Never-started originals are retired with the replacement, not left as ready cards.
      const detail = (await applications.api.work.detail(key))!.data.delegation!.children;
      for (const [index, child] of original.children.slice(1).entries()) {
        const replacement = repaired!.children[index + 1]!;
        expect(board.cards[child.workItemId]).toMatchObject({
          condition: 'finished',
          superseded: true,
        });
        expect(detail.find((entry) => entry.workItemId === child.workItemId)).toMatchObject({
          status: 'superseded',
          supersededBy: {
            workItemKey: toWorkItemKey(replacement.workItemId),
            cohortId: 'repair',
            assignmentId: replacement.assignmentId,
          },
        });
      }
      // Each retirement is journaled exactly once, and reconciliation never repeats it.
      const retirements = async () =>
        (await root.journal.readAll(0)).filter(
          ({ event }) => event.eventType === 'orchestration.delegation-child-superseded',
        ).length;
      expect(await retirements()).toBe(2);
      await root.orchestration.reconcileChildCompletions(context('reconcile-again'));
      expect(await retirements()).toBe(2);
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
  },
);

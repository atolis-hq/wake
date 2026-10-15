import { EventActorKind, correlationId } from '@atolis-hq/eventing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  PullRequestCheckState,
  PullRequestMergeability,
  PullRequestState,
} from '../../../src/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import { createOneShotRunnerAdvance } from '../../../src/bootstrap/runner-tick-adapter.js';
import {
  DeliveryIntentEventType,
  DurableFakeDeliveryProvider,
  selectDeliveryIntentEvent,
} from '../../../src/integrations/index.js';
import {
  WorkflowStatus,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceCapability,
  ResourceCorrelationRole,
  resourceKind,
} from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

defineScenario(
  {
    id: 'E2E-MERGE-WAIT-001',
    title: 'merge waits reconcile explicit conflict, closure, unknown, and merged observations',
    given: ['primary PR and pinned merge workflow using permanent fake delivery'],
    when: ['the provider reports unknown mergeability, conflict, closure, or merge'],
    then: ['unknown waits, conflict and closure block explicitly, and merge completes'],
  },
  async () => {
    for (const problem of [
      PullRequestMergeability.Conflicting,
      PullRequestState.Closed,
      PullRequestState.Merged,
    ]) {
      const path = await mkdtemp(join(tmpdir(), 'wake-merge-wait-scenario-'));
      try {
        const root = await createCompositionRoot(path, {
          config: parseRootConfig({
            schemaVersion: 1,
            execution: {
              agentRunners: { fake: { kind: 'fake' } },
              runnerPools: { standard: ['fake'] },
              defaultRunnerPool: 'standard',
            },
            orchestration: {
              default: 'merge',
              workflows: {
                merge: {
                  entry: 'merge',
                  stages: {
                    merge: {
                      activity: 'pr.merge',
                      requiresApproval: false,
                      with: {
                        target: 'primary',
                        method: 'squash',
                        requireChecks: false,
                        requireApproval: false,
                        autoMerge: true,
                        blockedPaths: [],
                      },
                      on: {
                        done: {
                          then: 'wait',
                          resourceTransitions: [
                            {
                              events: ['pr.state-changed'],
                              where: { state: 'merged' },
                              then: 'done',
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            integrations: { fake: { enabled: true } },
          }),
          fakeDeliveryProvider: new DurableFakeDeliveryProvider(),
        });
        let ordinal = 0;
        const command = () => ({
          commandId: `scenario-${problem}-${++ordinal}`,
          correlationId: correlationId('merge-wait'),
          occurredAt: '2026-10-14T12:00:00Z',
          actor: { kind: EventActorKind.Operator, id: 'test' },
        });
        const workItemId = workId(`merge-${problem}`);
        const resourceId = resId(`merge-${problem}`);
        const instanceId = workflowInstanceId(`merge-${problem}`);
        await root.work.create({ workItemId, objective: 'Reconcile merge wait' }, command());
        await root.resources.discover(
          {
            resourceId,
            kind: resourceKind('pull-request'),
            externalKey: { adapter: 'fake', key: problem },
            capabilities: [
              BuiltInResourceCapability.Mergeable,
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Revisioned,
            ],
          },
          command(),
        );
        await root.resources.correlate(
          resourceId,
          workItemId,
          ResourceCorrelationRole.Primary,
          command(),
        );
        const observe = (state: PullRequestState, mergeability: PullRequestMergeability) =>
          root.pullRequests.observe(
            {
              resourceId,
              workItemId,
              state,
              mergeability,
              headRevision: 'head',
              baseRevision: 'base',
              checks: PullRequestCheckState.Passing,
            },
            command(),
          );
        await observe(PullRequestState.Open, PullRequestMergeability.Unknown);
        await root.orchestration.start(
          {
            workflowInstanceId: instanceId,
            workItemId,
            workflowName: workflowName('merge'),
            orchestrationGroupId: orchestrationGroupId(problem),
          },
          command(),
        );
        const tick = () => createOneShotRunnerAdvance(root)({ maxProgress: 1 });
        for (
          let i = 0;
          i < 8 && (await root.orchestration.get(instanceId))?.status !== WorkflowStatus.Waiting;
          i++
        )
          await tick();
        expect((await root.orchestration.get(instanceId))?.status).toBe(WorkflowStatus.Waiting);
        await tick();
        expect((await root.orchestration.get(instanceId))?.status).toBe(WorkflowStatus.Waiting);
        const replies = (await root.journal.readAll(0))
          .map(selectDeliveryIntentEvent)
          .filter(
            (event) => event?.event.eventType === DeliveryIntentEventType.ReplyPublishRequested,
          );
        expect(replies).toHaveLength(1);
        const reply = replies[0]!;
        expect(reply.event.payload).toMatchObject({
          body: expect.stringContaining('Awaiting merge'),
          publicationOnly: true,
        });
        expect(JSON.stringify(reply.event.payload)).not.toContain('/changes');
        const observation = problemObservation(problem);
        await observe(observation.state, observation.mergeability);
        await tick();
        const view = await root.orchestration.get(instanceId);
        expect(view?.status).toBe(
          problem === PullRequestState.Merged ? WorkflowStatus.Completed : WorkflowStatus.Blocked,
        );
        if (problem !== PullRequestState.Merged)
          expect(view?.blockReason).toContain(
            problem === PullRequestState.Closed ? 'pr-closed-unmerged' : 'pr-conflicting',
          );
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    }
  },
  120000,
);

function problemObservation(problem: 'conflicting' | 'closed' | 'merged') {
  return {
    state: problem === PullRequestMergeability.Conflicting ? PullRequestState.Open : problem,
    mergeability:
      problem === PullRequestMergeability.Conflicting
        ? PullRequestMergeability.Conflicting
        : PullRequestMergeability.Unknown,
  };
}

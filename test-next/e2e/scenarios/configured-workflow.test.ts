import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
  type ActivityDefinition,
} from '../../../src-next/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src-next/bootstrap/index.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src-next/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src-next/persistence/index.js';
import {} from '../../../src-next/work/index.js';
import { workId } from '../../support/identities.js';

describe('E2E-CONFIG-001 configured workflow', () => {
  it('composes the module subtrees and completes one fake activity stage', async () => {
    const activity: ActivityDefinition = {
      name: activityName('implement'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
      outcomeKinds: [ActivityOutcomeKind.Done],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
    };
    const activities = new ActivityRegistry();
    activities.register(activity);
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: {
                activity: 'implement',
                with: { prompt: 'implement' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });
    const clock = { now: () => new Date('2026-07-31T00:00:00.000Z') };
    const runtime = await createCompositionRoot('C:/wake-home', {
      config,
      activities,
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });
    const context = {
      commandId: 'config-test',
      correlationId: correlationId('config-test'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    const item = await runtime.work.create(
      { workItemId: workId('config'), objective: 'configured' },
      context,
    );
    const workflow = await runtime.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-config'),
        workItemId: item.workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('group-config'),
      },
      context,
    );
    const result = await runtime.advanceOnce({ maxProgress: 1 });

    expect(result.kind).toBe('progressed');
    expect((await runtime.orchestration.get(workflow.workflowInstanceId))?.status).toBe(
      'completed',
    );
    expect(runtime.config.execution.defaultRunnerPool).toBe('standard');
  });
});

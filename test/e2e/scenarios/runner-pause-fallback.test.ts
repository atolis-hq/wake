import { correlationId } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { ActivityRegistry, agentActivityDefinition } from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  controlPlaneStream,
  createControlPlaneEventData,
} from '../../../src/control-plane/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import { workId } from '../../support/identities.js';
import { FakeClock } from '../support/world.js';

it('E2E-CONTROL-QUOTA-001: a durable quota pause falls sideways, replays, expires, and can resume early', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const root = await createRoot(clock, journal, projections, checkpoints);

  await appendQuotaPause(journal, clock, '2026-07-30T12:30:00.000Z');
  await root.projectionSubscriptions.catchUpOnce();
  expect(await runnerHealth(root, clock)).toContainEqual(
    expect.objectContaining({ runnerId: 'sonnet', status: 'paused', available: false }),
  );
  await startAndAdvance(root, 'fallback');
  expect((await root.execution.list()).at(-1)?.runner?.name).toBe('codex-mini');

  const restarted = await createRoot(clock, journal, projections, checkpoints);
  await restarted.projectionSubscriptions.catchUpOnce();
  await startAndAdvance(restarted, 'replayed');
  expect((await restarted.execution.list()).at(-1)?.runner?.name).toBe('codex-mini');

  clock.advance(30 * 60 * 1000);
  await startAndAdvance(restarted, 'expired');
  expect((await restarted.execution.list()).at(-1)?.runner?.name).toBe('sonnet');

  await appendQuotaPause(journal, clock, '2026-07-30T13:30:00.000Z');
  await restarted.projectionSubscriptions.catchUpOnce();
  await restarted.runnerControls.unpause('sonnet', 'operator-resume-1');
  await restarted.projectionSubscriptions.catchUpOnce();
  expect(await runnerHealth(restarted, clock)).toContainEqual(
    expect.objectContaining({ runnerId: 'sonnet', status: 'available', available: true }),
  );
  await startAndAdvance(restarted, 'resumed');
  expect((await restarted.execution.list()).at(-1)?.runner?.name).toBe('sonnet');
}, 30_000);

async function createRoot(
  clock: FakeClock,
  journal: InMemoryEventJournal,
  projections: InMemoryProjectionStore,
  checkpoints: InMemoryCheckpointStore,
) {
  const activities = new ActivityRegistry();
  activities.register(agentActivityDefinition);
  return createCompositionRoot('C:/wake-home', {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      execution: {
        agentRunners: { sonnet: { kind: 'fake' }, 'codex-mini': { kind: 'fake' } },
        runnerPools: { standard: ['sonnet', 'codex-mini'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: {
                activity: agentActivityDefinition.name,
                with: { prompt: 'ship' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    activities,
    clock,
    journal,
    projections,
    checkpoints,
  });
}

async function appendQuotaPause(
  journal: InMemoryEventJournal,
  clock: FakeClock,
  resumeAt: string,
): Promise<void> {
  const stream = controlPlaneStream();
  const occurredAt = clock.now().toISOString();
  await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
    createControlPlaneEventData({
      eventId: `quota-${occurredAt}:control-plane.runner-paused`,
      eventType: ControlEventType.RunnerPaused,
      occurredAt,
      correlationId: correlationId(`quota-${occurredAt}`),
      causationId: `quota-${occurredAt}`,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {
        runnerName: 'sonnet',
        cause: 'quota',
        reason: 'provider quota exhausted',
        resumeAt,
      },
    }),
  ]);
}

async function startAndAdvance(
  root: Awaited<ReturnType<typeof createRoot>>,
  suffix: string,
): Promise<void> {
  const context = {
    commandId: `runner-fallback-${suffix}`,
    correlationId: correlationId(`runner-fallback-${suffix}`),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'system' as const, id: 'test' },
  };
  const work = await root.work.create(
    { workItemId: workId(`runner-fallback-${suffix}`), objective: suffix },
    context,
  );
  await root.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(`runner-fallback-${suffix}`),
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId(`runner-fallback-${suffix}`),
    },
    context,
  );
  await root.advanceOnce({ maxProgress: 1 });
}

async function runnerHealth(root: Awaited<ReturnType<typeof createRoot>>, clock: FakeClock) {
  const runners = (
    await createSurfaceApplications(root, {
      now: () => clock.now().toISOString(),
    })
  ).api.execution.runners;
  if (runners === undefined) throw new Error('Expected production runner health application');
  return (await runners({ limit: 10 })).items;
}

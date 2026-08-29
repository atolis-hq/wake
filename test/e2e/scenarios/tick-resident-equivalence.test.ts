import { expect, it } from 'vitest';
import {
  composeControlPlaneHosts,
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { EventActorKind, correlationId } from '../../../src/kernel/index.js';
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

const scenario = { id: 'E2E-CONTROL-002' } as const;

it(`${scenario.id}: TickHost and ResidentHost share bounded advancement`, async () => {
  const calls: number[] = [];
  const controller = new AbortController();
  const runtime = composeControlPlaneHosts(async () => {
    calls.push(calls.length);
    if (calls.length === 2) controller.abort();
    return { kind: 'no-work' as const };
  });
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };
  await expect(runtime.tick.run(budget)).resolves.toMatchObject({ stoppedBecause: 'idle' });
  await expect(runtime.resident.run(controller.signal, budget)).resolves.toMatchObject({
    stoppedBecause: 'shutdown',
  });
  expect(calls).toHaveLength(2);
});

it('E2E-CONTROL-006: parsed inline rollback and subscriber migration share the composed tick and resident lifecycle', async () => {
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 };
  const trace: string[] = [];

  for (const mode of ['inline', 'subscriber'] as const) {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const residentStarted = deferred<void>();
    const controller = new AbortController();
    let starts = 0;
    const root = await createCompositionRoot(`C:/wake-${mode}-lifecycle`, {
      config: schedulerModeConfig(mode),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            starts += 1;
            trace.push(`${mode}:runner:${starts}`);
            if (starts === 2) {
              residentStarted.resolve();
              controller.abort();
            }
            return runner.start(request, signal);
          },
        };
      },
    });
    const applications = await createSurfaceApplications(root, {
      now: () => clock.now().toISOString(),
    });

    await startWorkflow(root, clock, mode, 'tick');
    await applications.cli.tick.run(budget);
    await startWorkflow(root, clock, mode, 'resident');
    const resident = applications.cli.start.run(controller.signal, budget);
    await residentStarted.promise;
    await resident;

    expect(starts).toBe(2);
  }

  expect(trace).toEqual([
    'inline:runner:1',
    'inline:runner:2',
    'subscriber:runner:1',
    'subscriber:runner:2',
  ]);
});

function schedulerModeConfig(mode: 'inline' | 'subscriber') {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'lifecycle',
      workflows: {
        lifecycle: {
          stages: {
            run: {
              activity: 'agent',
              with: { prompt: 'lifecycle' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: { activationScheduler: { mode } },
    integrations: {},
    surfaces: {},
  });
}

async function startWorkflow(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  clock: { now(): Date },
  mode: string,
  phase: string,
) {
  const id = `${mode}-${phase}`;
  const context = {
    commandId: id,
    correlationId: correlationId(id),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: 'test' },
  };
  const work = await root.work.create(
    { workItemId: workId(id), objective: `${phase} lifecycle work` },
    context,
  );
  await root.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(`workflow-${id}`),
      workItemId: work.workItemId,
      workflowName: workflowName('lifecycle'),
      orchestrationGroupId: orchestrationGroupId(`group-${id}`),
    },
    context,
  );
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

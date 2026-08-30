import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  composeControlPlaneHosts,
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { ExecutionEventType } from '../../../src/execution/index.js';
import { DeliveryEventType } from '../../../src/integrations/index.js';
import { EventActorKind, correlationId } from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
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

it('E2E-CONTROL-006: tick and resident lifecycle use subscription-only scheduling', async () => {
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 };
  const trace: string[] = [];
  const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
  const residentStarted = deferred<void>();
  const controller = new AbortController();
  let starts = 0;
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-subscription-lifecycle-'));
  try {
    const root = await createCompositionRoot(wakeRoot, {
      config: subscriptionConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            starts += 1;
            trace.push(`runner:${starts}`);
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

    await startWorkflow(root, clock, 'tick');
    await applications.cli.tick.run(budget);

    const residentRun = applications.cli.start.run(controller.signal, budget);
    try {
      await startWorkflow(root, clock, 'resident');
      await residentStarted.promise;
    } finally {
      controller.abort();
      await residentRun;
    }

    expect(starts).toBe(2);
    expect(trace).toEqual(['runner:1', 'runner:2']);
  } finally {
    await rm(wakeRoot, { recursive: true, force: true });
  }
});

it('E2E-CONTROL-007: resident processing advances inbound, orchestration, artifact, run, and delivery facts from durable checkpoints', async () => {
  const clock = { now: () => new Date('2026-08-30T00:00:00.000Z') };
  const controller = new AbortController();
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-realtime-processor-runtime-'));
  try {
    await writeFile(
      join(wakeRoot, 'fake-scenarios.yaml'),
      `schemaVersion: 1\nrules:\n  - name: report-artifact\n    when: { runner: fake, action: agent }\n    afterMs: 1\n    outcome: DONE\n    reportedArtifacts:\n      - kind: pull-request\n        externalKey: { adapter: fake, key: owner/repo#42 }\n`,
    );
    const journal = new InMemoryEventJournal(clock);
    const root = await createCompositionRoot(wakeRoot, {
      config: realtimeConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      subscriptionRunSerialiser: createInMemoryProcessorRunSerialiser(),
      clock,
    });
    const applications = await createSurfaceApplications(root, {
      now: () => clock.now().toISOString(),
    });
    const resident = applications.cli.start.run(controller.signal, {
      maxAdvances: 1,
      maxRuns: 1,
      maxDurationMs: 1_000,
    });
    try {
      const delivered = await waitForJournalEvent(
        journal,
        0,
        (event) => event.eventType === DeliveryEventType.Confirmed,
      );
      const runStarted = (await journal.readAll(0)).find(
        (event) => event.eventType === ExecutionEventType.RunStarted,
      );
      const acceptedOutcome = (await journal.readAll(0)).find(
        (event) => event.eventType === OrchestrationEventType.ActivityOutcomeAccepted,
      );
      expect(runStarted).toBeDefined();
      expect(acceptedOutcome).toBeDefined();

      await Promise.all([
        waitForCheckpoint(root, 'reactor:integration.fake.inbound', delivered.globalPosition),
        waitForCheckpoint(
          root,
          'subscriber:control-plane.activation-scheduler',
          acceptedOutcome!.globalPosition,
        ),
        waitForCheckpoint(root, 'reactor:artifact-registration', acceptedOutcome!.globalPosition),
        waitForCheckpoint(root, 'projection:execution', runStarted!.globalPosition),
        waitForCheckpoint(root, 'reactor:agent-run-publication', delivered.globalPosition),
        waitForCheckpoint(root, 'reactor:delivery-outcomes', delivered.globalPosition),
      ]);
    } finally {
      controller.abort();
      await resident;
    }
  } finally {
    await rm(wakeRoot, { recursive: true, force: true });
  }
});

function subscriptionConfig() {
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
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

function realtimeConfig() {
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
      default: 'realtime',
      workflows: {
        realtime: {
          stages: {
            implement: {
              activity: 'agent',
              with: { prompt: 'report the artifact' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {},
    integrations: {
      fake: {
        enabled: true,
        provider: 'fake',
        events: [
          {
            key: 'owner/repo#7',
            title: 'Process real-time facts',
            kind: 'issue',
          },
          {
            key: 'owner/repo#42',
            title: 'Reported real-time artifact',
            kind: 'pull-request',
            eligible: false,
            revision: 'head-42',
            branch: 'wake/fake-work',
          },
        ],
      },
    },
    surfaces: {},
  });
}

async function waitForCheckpoint(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  consumer: string,
  position: number,
): Promise<void> {
  await vi.waitFor(async () => {
    await expect(root.checkpoints.load(consumer)).resolves.toBeGreaterThanOrEqual(position);
  });
}

async function waitForJournalEvent(
  journal: InMemoryEventJournal,
  after: number,
  predicate: (event: Awaited<ReturnType<InMemoryEventJournal['readAll']>>[number]) => boolean,
) {
  await vi.waitFor(async () => {
    const event = (await journal.readAll(after)).find(predicate);
    expect(event).toBeDefined();
  });
  return (await journal.readAll(after)).find(predicate)!;
}

async function startWorkflow(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  clock: { now(): Date },
  phase: string,
) {
  const id = `subscriber-${phase}`;
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

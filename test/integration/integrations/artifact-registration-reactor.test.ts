import { describe, expect, it, vi } from 'vitest';
import {
  activationId,
  activityOrchestrationGroupId,
  ActivityOutcomeKind,
  activityWorkflowInstanceId,
  BuiltInActivityName,
  createAgentActivity,
} from '../../../src/activities/index.js';
import { EventProcessorHost } from '../../../src/eventing/index.js';
import { ArtifactRegistrationReactor } from '../../../src/integrations/index.js';
import { createEventData, EventActorKind } from '../../../src/kernel/index.js';
import { workflowInstanceId, workflowInstanceStream } from '../../../src/orchestration/index.js';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src/persistence/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

describe('ArtifactRegistrationReactor', () => {
  it('exposes its stable event processor identity', () => {
    const reactor = new ArtifactRegistrationReactor({ journal: {} } as never);

    expect(reactor).toMatchObject({
      processor: {
        consumer: 'reactor:artifact-registration',
        name: 'artifact-registration',
        owner: 'integrations',
      },
    });
  });

  it('skips unrelated facts while advancing its processor checkpoint', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const host = new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    );
    await journal.appendToStream({ kind: 'test', id: 'unrelated' }, 0, [
      createEventData({
        eventId: 'unrelated-artifact-fact',
        eventType: 'work.created',
        occurredAt: '2026-08-30T00:00:00.000Z',
        correlationId: 'artifact-correlation',
        causationId: 'artifact-cause',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream: { kind: 'test', id: 'unrelated' },
        payload: {},
      }),
    ]);
    const reactor = new ArtifactRegistrationReactor({ journal } as never);

    await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({
      eventCount: 1,
      handledCount: 0,
    });
  });

  it('verifies a reported artifact before discovering and correlating it', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const host = new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    );
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact');
    const activation = activationId('activation-artifact');
    await journal.appendToStream(workflowInstanceStream(workflow), 0, [
      draft(
        'orchestration.instance-started',
        {
          workItemId: workId('artifact-work'),
          workflowName: 'default',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        workflow,
      ),
      draft(
        'orchestration.activity-outcome-accepted',
        {
          activationId: activation,
          outcome: {
            kind: ActivityOutcomeKind.Done,
            data: {
              status: 'DONE',
              reportedArtifacts: [
                { kind: 'pull-request', externalKey: { adapter: 'fake', key: 'repo#42' } },
              ],
            },
          },
        },
        workflow,
      ),
    ]);

    const reactor = new ArtifactRegistrationReactor({
      journal,
      resources,
      ids: { next: () => 'resource-00000000000000000000000000' },
      runs: {
        async list() {
          return [
            { workspace: { mode: 'branch' as const, path: '/tmp', branch: 'wake/fake-work' } },
          ] as never;
        },
      },
      providers: [
        {
          adapter: 'fake' as never,
          provider: 'fake',
          eventTypes: [],
          source: {} as never,
          delivery: {} as never,
          inbound: {} as never,
          async verifyArtifact(kind, externalKey, context) {
            expect(context.workspaceBranch).toBe('wake/fake-work');
            return { kind, externalKey, capabilities: [], revision: 'head-a' };
          },
        },
      ],
    });

    await host.runOnce(reactor.processor);

    const resource = await resources.findByExternalKey({ adapter: 'fake', key: 'repo#42' });
    expect(resource).toMatchObject({ kind: resourceKind('pull-request'), revision: 'head-a' });
    await expect(resources.correlations(resource!.resourceId)).resolves.toMatchObject([
      { workItemId: workId('artifact-work'), role: 'primary', provenance: 'agent-reported' },
    ]);
  });

  it('correlates a PR declared in a raw agent report with the originating WorkItem', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const host = new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    );
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact-raw');
    const activation = activationId('activation-artifact-raw');
    const rawOutput = `Opened https://github.com/atolis-hq/wake/pull/537.

\`\`\`wake-artifacts
{ "artifacts": [{ "kind": "pr", "url": "https://github.com/atolis-hq/wake/pull/537" }] }
\`\`\`

DONE`;
    const outcome = await createAgentActivity().execute(
      {
        activationId: activation,
        activity: BuiltInActivityName.Agent,
        workItemId: workId('artifact-raw-work'),
        workflowInstanceId: activityWorkflowInstanceId(workflow),
        orchestrationGroupId: activityOrchestrationGroupId('group-1'),
        causationId: 'raw-agent-report',
        input: { prompt: 'ship' },
        resources: [],
      },
      {
        signal: new AbortController().signal,
        occurredAt: '2026-08-12T00:00:00.000Z',
        runner: {
          async start() {
            return {
              result: Promise.resolve({ transport: 'succeeded' as const, output: rawOutput }),
            };
          },
        },
        async reportExternalExecution() {},
      },
    );
    await journal.appendToStream(workflowInstanceStream(workflow), 0, [
      draft(
        'orchestration.instance-started',
        {
          workItemId: workId('artifact-raw-work'),
          workflowName: 'default',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        workflow,
      ),
      draft(
        'orchestration.activity-outcome-accepted',
        { activationId: activation, outcome },
        workflow,
      ),
    ]);
    const reactor = new ArtifactRegistrationReactor({
      journal,
      resources,
      ids: { next: () => 'resource-00000000000000000000000000' },
      runs: {
        async list() {
          return [
            { workspace: { mode: 'branch' as const, path: '/tmp', branch: 'wake/raw-work' } },
          ] as never;
        },
      },
      providers: [
        {
          adapter: 'github' as never,
          provider: 'github',
          eventTypes: [],
          source: {} as never,
          delivery: {} as never,
          inbound: {} as never,
          async verifyArtifact(kind, externalKey, context) {
            expect(context.workspaceBranch).toBe('wake/raw-work');
            return { kind, externalKey, capabilities: [], revision: 'head-a' };
          },
        },
      ],
    });

    await host.runOnce(reactor.processor);

    const resource = await resources.findByExternalKey({
      adapter: 'github',
      key: 'atolis-hq/wake#537',
    });
    await expect(resources.correlations(resource!.resourceId)).resolves.toMatchObject([
      { workItemId: workId('artifact-raw-work'), role: 'primary', provenance: 'agent-reported' },
    ]);
  });

  it('records a durable failed verification instead of trusting a missing artifact', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const host = new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    );
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact-missing');
    await journal.appendToStream(workflowInstanceStream(workflow), 0, [
      draft(
        'orchestration.instance-started',
        {
          workItemId: workId('artifact-missing'),
          workflowName: 'default',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        workflow,
      ),
      draft(
        'orchestration.activity-outcome-accepted',
        {
          activationId: activationId('activation-artifact-missing'),
          outcome: {
            kind: ActivityOutcomeKind.Done,
            data: {
              status: 'DONE',
              reportedArtifacts: [
                { kind: 'pull-request', externalKey: { adapter: 'fake', key: 'missing#42' } },
              ],
            },
          },
        },
        workflow,
      ),
    ]);
    const reactor = new ArtifactRegistrationReactor({
      journal,
      resources,
      ids: { next: () => 'resource-00000000000000000000000000' },
      runs: {
        async list() {
          return [
            { workspace: { mode: 'branch' as const, path: '/tmp', branch: 'wake/fake-work' } },
          ] as never;
        },
      },
      providers: [
        {
          adapter: 'fake' as never,
          provider: 'fake',
          eventTypes: [],
          source: {} as never,
          delivery: {} as never,
          inbound: {} as never,
          async verifyArtifact() {
            return 'not-found' as const;
          },
        },
      ],
    });

    await host.runOnce(reactor.processor);

    expect(
      (await journal.readAll(0)).some(
        (event) => event.eventType === 'integration.artifact-verification-unresolved',
      ),
    ).toBe(true);
    expect(await checkpoints.load('reactor:artifact-registration')).toBeGreaterThan(0);
  });

  it('stops re-scanning the full journal for ambiguous reconciliation once nothing is pending', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const host = new EventProcessorHost(
      journal,
      checkpoints,
      createInMemoryProcessorRunSerialiser(),
    );
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact-ambiguous');
    await journal.appendToStream(workflowInstanceStream(workflow), 0, [
      draft(
        'orchestration.instance-started',
        {
          workItemId: workId('artifact-ambiguous'),
          workflowName: 'default',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        workflow,
      ),
      draft(
        'orchestration.activity-outcome-accepted',
        {
          activationId: activationId('activation-artifact-ambiguous'),
          outcome: {
            kind: ActivityOutcomeKind.Done,
            data: {
              status: 'DONE',
              reportedArtifacts: [
                { kind: 'pull-request', externalKey: { adapter: 'fake', key: 'ambiguous#42' } },
              ],
            },
          },
        },
        workflow,
      ),
    ]);
    const reactor = new ArtifactRegistrationReactor({
      journal,
      resources,
      ids: { next: () => 'resource-00000000000000000000000000' },
      maxAmbiguityReconciliationAttempts: 1,
      runs: {
        async list() {
          return [
            { workspace: { mode: 'branch' as const, path: '/tmp', branch: 'wake/fake-work' } },
          ] as never;
        },
      },
      providers: [
        {
          adapter: 'fake' as never,
          provider: 'fake',
          eventTypes: [],
          source: {} as never,
          delivery: {} as never,
          inbound: {} as never,
          async verifyArtifact() {
            return 'ambiguous' as const;
          },
        },
      ],
    });

    // First attempt is escalated immediately (max attempts = 1), so this
    // settles into a stable, unresolved-but-no-longer-retried state.
    await host.runOnce(reactor.processor);

    const readAllSpy = vi.spyOn(journal, 'readAll');
    await host.runOnce(reactor.processor);
    await host.runOnce(reactor.processor);

    const fullRescans = readAllSpy.mock.calls.filter(([position]) => position === 0);
    expect(fullRescans).toHaveLength(0);
  });
});

function draft(
  eventType: string,
  payload: unknown,
  workflow: ReturnType<typeof workflowInstanceId>,
) {
  return createEventData({
    eventId: `${eventType}:artifact`,
    eventType,
    occurredAt: '2026-08-02T00:00:00.000Z',
    correlationId: 'artifact-correlation',
    causationId: 'artifact-cause',
    actor: { kind: EventActorKind.System, id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: workflowInstanceStream(workflow),
    payload,
  });
}

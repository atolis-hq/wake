import { describe, expect, it } from 'vitest';
import {
  activationId,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  ActivityOutcomeKind,
  BuiltInActivityName,
  createAgentActivity,
} from '../../../src/activities/index.js';
import { ArtifactRegistrationReactor } from '../../../src/integrations/index.js';
import { createEventDraft, EventActorKind } from '../../../src/kernel/index.js';
import { workflowInstanceId, workflowInstanceStream } from '../../../src/orchestration/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../../src/persistence/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

describe('ArtifactRegistrationReactor', () => {
  it('verifies a reported artifact before discovering and correlating it', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact');
    const activation = activationId('activation-artifact');
    await journal.append(workflowInstanceStream(workflow), 0, [
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
      checkpoints,
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

    await reactor.runOnce();

    const resource = await resources.findByExternalKey({ adapter: 'fake', key: 'repo#42' });
    expect(resource).toMatchObject({ kind: resourceKind('pull-request'), revision: 'head-a' });
    await expect(resources.correlations(resource!.resourceId)).resolves.toMatchObject([
      { workItemId: workId('artifact-work'), role: 'primary', provenance: 'agent-reported' },
    ]);
  });

  it('correlates a PR declared in a raw agent report with the originating WorkItem', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const checkpoints = new InMemoryCheckpointStore();
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
            return { result: Promise.resolve({ transport: 'succeeded' as const, output: rawOutput }) };
          },
        },
        async reportExternalExecution() {},
      },
    );
    await journal.append(workflowInstanceStream(workflow), 0, [
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
      checkpoints,
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

    await reactor.runOnce();

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
    const { resources } = createTestResourceServices(journal);
    const workflow = workflowInstanceId('workflow-artifact-missing');
    await journal.append(workflowInstanceStream(workflow), 0, [
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
      checkpoints,
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

    await reactor.runOnce();

    expect(
      (await journal.readAll(0)).some(
        (event) => event.eventType === 'integration.artifact-verification-unresolved',
      ),
    ).toBe(true);
    expect(await checkpoints.load('reactor:artifact-registration')).toBeGreaterThan(0);
  });
});

function draft(
  eventType: string,
  payload: unknown,
  workflow: ReturnType<typeof workflowInstanceId>,
) {
  return createEventDraft({
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

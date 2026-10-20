import { createEventData, EventActorKind, EventProcessorHost } from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { activationId, ActivityOutcomeKind } from '../../../src/activities/index.js';
import { ArtifactRegistrationReactor } from '../../../src/integrations/index.js';
import { workflowInstanceId, workflowInstanceStream } from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const outputs = ['api', 'web'].map((name) => ({
  name,
  branch: `${name}-branch`,
  path: `/tmp/${name}`,
  repository: {
    resourceId: 'resource-00000000000000000000000001',
    sourceRef: 'main',
    pullRequestBase: `${name}-base`,
  },
  revision: `${name}-head`,
}));

const multiOutputRun = {
  workspace: {
    mode: 'branch' as const,
    path: '/tmp',
    branch: 'api-branch',
    changeOutputs: outputs,
  },
  changeOutputs: outputs,
};

const claim = (name: string | undefined, key: string) => ({
  ...(name === undefined ? {} : { name }),
  kind: 'pull-request',
  externalKey: { adapter: 'fake', key },
});

async function register(reported: unknown[]) {
  const journal = new InMemoryEventJournal(new FakeClock());
  const host = new EventProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );
  const { resources } = createTestResourceServices(journal);
  const workflow = workflowInstanceId('workflow-multi-output');
  await journal.appendToStream(workflowInstanceStream(workflow), 0, [
    draft('orchestration.instance-started', {
      workItemId: workId('multi-output-work'),
      workflowName: 'default',
      orchestrationGroupId: 'group-1',
      entry: 'implement',
    }),
    draft('orchestration.activity-outcome-accepted', {
      activationId: activationId('activation-multi-output'),
      outcome: {
        kind: ActivityOutcomeKind.Done,
        data: { status: 'DONE', reportedArtifacts: reported },
      },
    }),
  ]);
  // Only the provider that matches the output's own branch and head may vouch for a PR.
  const owners = new Map([
    ['api-pr', outputs[0]!],
    ['web-pr', outputs[1]!],
  ]);
  const verified: string[] = [];
  let minted = 0;
  const guarded = Object.create(resources) as typeof resources;
  guarded.get = (async () => ({ externalKey: { adapter: 'fake', key: 'org/repo' } })) as never;
  const reactor = new ArtifactRegistrationReactor({
    journal,
    resources: guarded,
    ids: { next: () => `resource-0000000000000000000000000${++minted + 1}` },
    runs: { list: async () => [multiOutputRun] as never },
    providers: [
      {
        adapter: 'fake' as never,
        provider: 'fake',
        eventTypes: [],
        source: {} as never,
        delivery: {} as never,
        inbound: {} as never,
        async verifyArtifact(kind, externalKey, source) {
          verified.push(externalKey.key);
          const owner = owners.get(externalKey.key);
          return owner !== undefined &&
            source.workspaceBranch === owner.branch &&
            source.workspaceRevision === owner.revision &&
            source.pullRequestBase === owner.repository.pullRequestBase
            ? { kind, externalKey, capabilities: [], revision: owner.revision }
            : ('not-found' as const);
        },
      },
    ],
  });
  await host.runOnce(reactor.processor);
  const events = await journal.readAll(0);
  return {
    resources,
    verified,
    unresolved: events.filter(
      (event) => event.event.eventType === 'integration.artifact-verification-unresolved',
    ).length,
  };
}

describe('ArtifactRegistrationReactor with several named outputs', () => {
  it('registers each PR only against its own output provenance', async () => {
    const result = await register([claim('api', 'api-pr'), claim('web', 'web-pr')]);
    expect(result.unresolved).toBe(0);
    for (const key of ['api-pr', 'web-pr'])
      expect(await result.resources.findByExternalKey({ adapter: 'fake', key })).not.toBeNull();
  });

  it.each([
    ['has no name', claim(undefined, 'api-pr')],
    ['uses an unknown name', claim('docs', 'api-pr')],
    ['names api but points at the web PR', claim('api', 'web-pr')],
  ])('leaves a claim that %s unresolved and unregistered', async (_label, reported) => {
    const result = await register([reported]);
    expect(result.unresolved).toBe(1);
    for (const key of ['api-pr', 'web-pr'])
      expect(await result.resources.findByExternalKey({ adapter: 'fake', key })).toBeNull();
  });

  it('does not let a valid claim vouch for a mismatched sibling claim', async () => {
    const result = await register([claim('api', 'api-pr'), claim('api', 'web-pr')]);
    expect(result.unresolved).toBe(1);
    expect(await result.resources.findByExternalKey({ adapter: 'fake', key: 'web-pr' })).toBeNull();
  });

  it('registers nothing when a revision run omits its report', async () => {
    const result = await register([]);
    expect(result.verified).toEqual([]);
    expect(result.unresolved).toBe(0);
    for (const key of ['api-pr', 'web-pr'])
      expect(await result.resources.findByExternalKey({ adapter: 'fake', key })).toBeNull();
  });
});

let sequence = 0;

function draft(eventType: string, payload: unknown) {
  return createEventData({
    eventId: `${eventType}:multi-output:${++sequence}`,
    eventType,
    occurredAt: '2026-08-02T00:00:00.000Z',
    correlationId: 'artifact-correlation',
    causationId: 'artifact-cause',
    actor: { kind: EventActorKind.System, id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload,
  });
}

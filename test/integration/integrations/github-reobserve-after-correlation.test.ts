import { EventProcessorHost, createEventData, type EventJournal } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { createPullRequestService } from '../../../src/activities/index.js';
import {
  BuiltInAdapterId,
  InboundTranslator,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src/integrations/github/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  createResourceLookup,
  createResourceService,
} from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

const payload: ExternalWorkObservedPayload = {
  externalKey: 'owner/repo#7',
  kind: 'pull-request',
  title: 'Add a.txt',
  body: '',
  state: 'open',
  revision: 'head-a',
  actor: { id: 'octocat', kind: 'human' },
  raw: {},
};

const prEvents = async (journal: EventJournal) =>
  (await journal.readAll(0)).filter((entry) => entry.event.eventType.startsWith('pr.'));

it('gives a PR observed before correlation its WorkItem observation once it is correlated', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  const lookup = createResourceLookup({
    journal,
    projections: new InMemoryProjectionStore(),
    checkpoints,
  });
  const resources = createResourceService(journal, lookup);
  const work = createWorkService(journal);
  const pullRequests = createPullRequestService(journal, work, resources);
  const translator = new InboundTranslator(journal, work, resources, {
    pullRequests,
    lookup,
    // As in production configuration, only issues are admitted; PRs are tracked via agent reports.
    intake: [
      {
        where: {
          kind: 'issue',
          state: ['open'],
          requiredAssignees: [],
          requiredAuthors: [],
          labels: [],
        },
        matchMode: 'all',
        ignoredLabels: [],
        tags: [],
      },
    ],
  });
  const context = {
    commandId: 'register',
    correlationId: 'github:pr-7' as never,
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  };

  // The poll sees the PR first; with no intake rule for it, no identity exists to observe it for.
  await journal.appendToStream(integrationStream(BuiltInAdapterId.GitHub), 0, [
    createEventData({
      eventId: 'github:pr-7',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:pr-7',
      causationId: 'github:pr-7',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      payload,
    }),
  ]);
  await new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  ).runOnce(translator.processor);
  expect(await prEvents(journal)).toEqual([]);

  // Before the agent registers the PR there is nothing to apply.
  await translator.reapplyObservation(payload.externalKey);
  expect(await prEvents(journal)).toEqual([]);

  // The agent reports the PR: Wake correlates it, then asks for the observation to be re-applied.
  const prResource = resId('github-owner-repo-7');
  const workItem = workId('7');
  await work.create({ workItemId: workItem, objective: 'child' }, context);
  await resources.discover(
    {
      resourceId: prResource,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'github', key: payload.externalKey },
      capabilities: [BuiltInResourceCapability.Reviewable, BuiltInResourceCapability.Revisioned],
      revision: payload.revision,
    },
    context,
  );
  await resources.correlate(
    prResource,
    workItem,
    ResourceCorrelationRole.Primary,
    context,
    ResourceCorrelationProvenance.AgentReported,
  );
  await translator.reapplyObservation(payload.externalKey);

  expect(await prEvents(journal)).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({
        eventType: 'pr.discovered',
        payload: expect.objectContaining({ workItemId: workItem, headRevision: 'head-a' }),
      }),
    }),
  ]);
  expect(await pullRequests.get(prResource)).toMatchObject({ workItemId: workItem });

  // Re-applying identical evidence is a no-op.
  await translator.reapplyObservation(payload.externalKey);
  expect(await prEvents(journal)).toHaveLength(1);
});

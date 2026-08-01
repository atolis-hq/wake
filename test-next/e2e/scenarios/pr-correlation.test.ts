import { expect, it } from 'vitest';
import { resId, workId } from '../../support/identities.js';

import {
  createPullRequestService,
  pullRequestProjection,
} from '../../../src-next/activities/index.js';
import {
  BuiltInAdapterId,
  InboundTranslator,
  createEventDraft,
  integrationStream,
  type ExternalWorkObservedPayload,
} from '../../../src-next/integrations/github/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../../src-next/persistence/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  createResourceLookup,
  createResourceService,
} from '../../../src-next/resources/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { FakeClock } from '../support/world.js';

it('E2E-PR-001 correlates a verified primary PR and rejects uncorrelated or conflicting review evidence', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  const projectionStore = new InMemoryProjectionStore();
  const lookup = createResourceLookup({ journal, projections: projectionStore });
  const resources = createResourceService(journal, lookup);
  const work = createWorkService(journal);
  const pullRequests = createPullRequestService(journal, work, resources);
  const prResource = resId('github-owner-repo-1');
  const payload = observation('head-a');
  const evidence = createEventDraft({
    eventId: 'github:pr-1',
    eventType: 'integration.github.work-observed',
    occurredAt: clock.now().toISOString(),
    correlationId: 'github:pr-1',
    causationId: 'github:pr-1',
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: integrationStream(BuiltInAdapterId.GitHub),
    payload,
  });
  await journal.append(evidence.stream, 0, [evidence]);
  const translator = new InboundTranslator(journal, checkpoints, work, resources, {
    pullRequests,
    lookup,
  });
  // This scenario proves correlation and review-evidence rejection, not admission, so the
  // WorkItem/Resource/correlation are pre-established: the translator resolves an existing
  // identity for the first observation and never needs to start a workflow.
  const workItem = workId('1');
  await preAdmit({ work, resources, clock, prResource, payload, workItem });

  expect(translator.translate(payload).map((candidate) => candidate.kind)).toContain('pr.observe');
  await translator.runOnce();
  await new ProjectionRunner(journal, projectionStore, checkpoints).runOnce(pullRequestProjection);
  const resource = await lookup.resourceIdForExternalKey({
    adapter: 'github',
    key: payload.externalKey,
  });
  expect(resource).not.toBeNull();
  const [correlation] = await resources.correlations(resource!);
  expect(correlation).toBeDefined();

  expect(await projectionStore.read('activities-pr', resource!)).toMatchObject({
    value: { workItemId: correlation!.workItemId, headRevision: 'head-a' },
  });
  expect(await resources.correlationsForWork(correlation!.workItemId)).toMatchObject([
    { role: 'primary' },
  ]);
  await appendObservation(journal, clock, observation('head-b'), 'github:pr-2');
  await translator.runOnce();
  expect((await journal.readAll(0)).map((event) => event.eventType)).toContain(
    'pr.revision-changed',
  );
  const safePullRequest = await pullRequests.get(prResource);
  expect(
    (await journal.readAll(0)).filter((event) => event.eventType === 'pr.review-rejected'),
  ).toHaveLength(0);

  await appendComment(journal, clock, 'owner/repo#unlinked', 'head-a', 'github:review-unlinked');
  await translator.runOnce();
  expect(
    (await journal.readAll(0)).filter((event) => event.eventType === 'pr.review-rejected'),
  ).toEqual([expect.objectContaining({ payload: { reason: 'missing-resource' } })]);
  expect(await work.get(correlation!.workItemId)).toMatchObject({
    objective: payload.title,
  });
  expect(await pullRequests.get(prResource)).toEqual(safePullRequest);

  await expect(
    resources.correlate(resource!, workId('2'), 'primary', {
      commandId: 'conflicting-primary',
      correlationId: 'github:pr-1' as never,
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'integration', id: 'github' },
    }),
  ).rejects.toThrow('primary');
  await appendComment(journal, clock, payload.externalKey, 'head-b', 'github:review-conflicted');
  await translator.runOnce();
  expect(
    (await journal.readAll(0)).filter((event) => event.eventType === 'pr.review-rejected'),
  ).toEqual([
    expect.objectContaining({ payload: { reason: 'missing-resource' } }),
    expect.objectContaining({ payload: { reason: 'correlation-conflict' } }),
  ]);
  expect(await work.get(correlation!.workItemId)).toMatchObject({
    objective: payload.title,
  });
  expect(await pullRequests.get(prResource)).toEqual(safePullRequest);
});

async function preAdmit(input: {
  work: ReturnType<typeof createWorkService>;
  resources: ReturnType<typeof createResourceService>;
  clock: FakeClock;
  prResource: ReturnType<typeof resId>;
  payload: ExternalWorkObservedPayload;
  workItem: ReturnType<typeof workId>;
}): Promise<void> {
  const { work, resources, clock, prResource, payload, workItem } = input;
  const admissionContext = {
    commandId: 'pre-admit',
    correlationId: 'github:pr-1' as never,
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  };
  await work.create({ workItemId: workItem, objective: payload.title }, admissionContext);
  await resources.discover(
    {
      resourceId: prResource,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'github', key: payload.externalKey },
      capabilities: [
        BuiltInResourceCapability.Commentable,
        BuiltInResourceCapability.Reviewable,
        BuiltInResourceCapability.Revisioned,
      ],
      revision: payload.revision,
    },
    admissionContext,
  );
  await resources.correlate(
    prResource,
    workItem,
    ResourceCorrelationRole.Primary,
    admissionContext,
  );
}

function observation(revision: string): ExternalWorkObservedPayload {
  return {
    externalKey: 'owner/repo#1',
    kind: 'pull-request',
    title: 'Implement Task 19',
    body: '',
    state: 'open',
    revision,
    actor: { id: 'octocat', kind: 'human' },
    raw: {},
  };
}

async function appendObservation(
  journal: InMemoryEventJournal,
  clock: FakeClock,
  payload: ExternalWorkObservedPayload,
  eventId: string,
) {
  const stream = integrationStream(BuiltInAdapterId.GitHub);
  await journal.append(stream, (await journal.readStream(stream)).length, [
    createEventDraft({
      eventId,
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: eventId,
      causationId: eventId,
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream,
      payload,
    }),
  ]);
}

async function appendComment(
  journal: InMemoryEventJournal,
  clock: FakeClock,
  externalKey: string,
  revision: string,
  eventId: string,
) {
  const event = createEventDraft({
    eventId,
    eventType: 'integration.github.comment-observed',
    occurredAt: clock.now().toISOString(),
    correlationId: eventId,
    causationId: eventId,
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: integrationStream(BuiltInAdapterId.GitHub),
    payload: {
      externalKey,
      body: '/accepted',
      revision,
      actor: { id: 'reviewer', kind: 'human' as const },
      raw: {},
    },
  });
  const stream = integrationStream(BuiltInAdapterId.GitHub);
  await journal.append(stream, (await journal.readStream(stream)).length, [event]);
}

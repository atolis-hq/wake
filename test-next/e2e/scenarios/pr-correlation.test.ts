import { expect, it } from 'vitest';

import {
  createPullRequestService,
  pullRequestProjection,
} from '../../../src-next/activities/index.js';
import {
  InboundTranslator,
  createEventDraft,
  entityRef,
  type ExternalWorkObservedPayload,
} from '../../../src-next/integrations/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';
import { ProjectionRunner } from '../../../src-next/persistence/index.js';
import { InMemoryProjectionStore } from '../../../src-next/persistence/index.js';
import { createResourceService, resourceId } from '../../../src-next/resources/index.js';
import { createWorkService, workItemId } from '../../../src-next/work/index.js';
import { FakeClock } from '../support/world.js';

it('E2E-PR-001 correlates a verified primary PR and rejects uncorrelated or conflicting review evidence', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const resources = createResourceService(journal);
  const work = createWorkService(journal);
  const checkpoints = new InMemoryCheckpointStore();
  const pullRequests = createPullRequestService(journal, work, resources);
  const prResource = resourceId('resource-github-owner-repo-1');
  const payload = observation('head-a');
  const evidence = createEventDraft({
    eventId: 'github:pr-1',
    eventType: 'integration.github.work-observed',
    occurredAt: clock.now().toISOString(),
    correlationId: 'github:pr-1',
    causationId: 'github:pr-1',
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: entityRef('integration', 'github'),
    payload,
  });
  await journal.append(evidence.stream, 0, [evidence]);
  const translator = new InboundTranslator(journal, checkpoints, work, resources, pullRequests);

  expect(translator.translate(payload).map((candidate) => candidate.kind)).toContain('pr.observe');
  await translator.runOnce();
  const projectionStore = new InMemoryProjectionStore();
  await new ProjectionRunner(journal, projectionStore, checkpoints).runOnce(pullRequestProjection);

  expect(await projectionStore.read('activities-pr', 'resource-github-owner-repo-1')).toMatchObject(
    {
      value: { workItemId: 'work-github-owner-repo-1', headRevision: 'head-a' },
    },
  );
  expect(await resources.correlationsForWork('work-github-owner-repo-1' as never)).toMatchObject([
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
  expect(await work.get('work-github-owner-repo-1' as never)).toMatchObject({
    objective: payload.title,
  });
  expect(await pullRequests.get(prResource)).toEqual(safePullRequest);

  await expect(
    resources.correlate('resource-github-owner-repo-1' as never, workItemId('work-2'), 'primary', {
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
  expect(await work.get('work-github-owner-repo-1' as never)).toMatchObject({
    objective: payload.title,
  });
  expect(await pullRequests.get(prResource)).toEqual(safePullRequest);
});

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
  const stream = entityRef('integration', 'github');
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
    stream: entityRef('integration', 'github'),
    payload: {
      externalKey,
      body: '/accepted',
      revision,
      actor: { id: 'reviewer', kind: 'human' as const },
      raw: {},
    },
  });
  const stream = entityRef('integration', 'github');
  await journal.append(stream, (await journal.readStream(stream)).length, [event]);
}

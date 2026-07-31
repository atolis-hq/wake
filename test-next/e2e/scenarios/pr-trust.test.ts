import { expect, it } from 'vitest';

import { createPullRequestMergeAuthorityGate } from '../../../src-next/activities/index.js';
import {
  InboundTranslator,
  BuiltInAdapterId,
  createEventDraft,
  githubReviewObservation,
  integrationStream,
} from '../../../src-next/integrations/index.js';
import { workItemId } from '../../../src-next/work/index.js';
import { mergeAuthorityTestActivity } from '../support/merge-authority-activity.js';
import { TestWorld } from '../support/world.js';

it('allows current-revision human acceptance through real merge authority', async () => {
  const world = new TestWorld();
  const translator = translatorFor(world);
  await appendObservation(world);
  await appendAcceptance(world, 'reviewer', ['reviewer']);
  await translator.runOnce();

  expect(
    await world.pullRequests.authorizeMerge(workItemId('work-github-owner-repo-7'), context(world)),
  ).toBe(true);
  expect(await world.events('pr.review-accepted')).toHaveLength(1);
});

it.each([
  ['unauthorized human', 'outsider', ['reviewer']],
  ['PR author self-approval', 'author', ['author']],
] as const)(
  'denies %s through production GitHub review translation',
  async (_case, actor, allowed) => {
    const world = new TestWorld();
    const translator = translatorFor(world);
    await appendObservation(world);
    await appendAcceptance(world, actor, allowed);
    await translator.runOnce();
    world.registerActivity(
      mergeAuthorityTestActivity(createPullRequestMergeAuthorityGate(world.pullRequests)),
    );
    world.configureWorkflow('merge', {
      stages: {
        merge: {
          activity: 'test.pr.merge-authority',
          with: {},
          on: { 'merge-denied': { then: 'merge', repeat: { max: 1 } } },
        },
      },
    });

    await world.startWorkflow({
      workItemId: workItemId('work-github-owner-repo-7'),
      workflowName: 'merge',
    });
    await world.advance(workItemId('work-github-owner-repo-7'));
    await world.advance(workItemId('work-github-owner-repo-7'));

    expect(await world.events('pr.review-accepted')).toHaveLength(0);
    expect(await world.events('pr.review-rejected')).toEqual([
      expect.objectContaining({ payload: { reason: 'untrusted-actor' } }),
    ]);
    expect(await world.events('pr.merge-denied')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'untrusted-actor' }),
        }),
      ]),
    );
    expect(await world.events('pr.merge-requested')).toHaveLength(0);
  },
);

function translatorFor(world: TestWorld): InboundTranslator {
  return new InboundTranslator(
    world.journal,
    world.checkpoints,
    world.work,
    world.resources,
    world.pullRequests,
  );
}

async function appendObservation(world: TestWorld): Promise<void> {
  await appendIntegrationEvent(world, 'github:pr-7', 'integration.github.work-observed', {
    externalKey: 'owner/repo#7',
    kind: 'pull-request',
    title: 'PR',
    body: '',
    state: 'open',
    revision: 'head-a',
    headRevision: 'head-a',
    baseRevision: 'base-a',
    checks: 'passing',
    actor: { id: 'author', kind: 'human' },
    raw: {},
  });
}

async function appendAcceptance(
  world: TestWorld,
  actorId: string,
  authorizedReviewers: readonly string[],
): Promise<void> {
  const event = githubReviewObservation({
    repository: 'owner/repo',
    pullRequest: pullRequestPayload(),
    review: {
      id: 101,
      state: 'APPROVED',
      body: null,
      commit_id: 'head-a',
      submitted_at: world.clock.now().toISOString(),
      user: { login: actorId, type: 'User' },
    },
    authorizedReviewers,
  });
  if (event === null) throw new Error('Approved GitHub review was not translated');
  await world.journal.append(event.stream, (await world.journal.readStream(event.stream)).length, [
    event,
  ]);
}

async function appendIntegrationEvent(
  world: TestWorld,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const stream = integrationStream(BuiltInAdapterId.GitHub);
  await world.journal.append(stream, (await world.journal.readStream(stream)).length, [
    createEventDraft({
      eventId,
      eventType,
      occurredAt: world.clock.now().toISOString(),
      correlationId: eventId,
      causationId: eventId,
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream,
      payload,
    }),
  ]);
}

function context(world: TestWorld) {
  return {
    commandId: 'authorize',
    correlationId: 'scenario-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}

function pullRequestPayload() {
  return {
    number: 7,
    title: 'PR',
    body: null,
    state: 'open' as const,
    updated_at: '2026-07-30T12:00:00.000Z',
    head: { sha: 'head-a' },
    base: { sha: 'base-a' },
    user: { login: 'author', type: 'User' },
  };
}

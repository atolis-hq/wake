import { expect, it } from 'vitest';
import { EventProcessorHost } from '../../../src/eventing/index.js';
import { workId } from '../../support/identities.js';
import { configureIntakeRouting } from '../support/intake-routing.js';

import {
  BuiltInAdapterId,
  createEventDraft,
  githubReviewObservation,
  InboundTranslator,
  integrationStream,
} from '../../../src/integrations/github/index.js';
import type { WorkflowRouter } from '../../../src/integrations/index.js';
import { createInMemoryProcessorRunSerialiser } from '../../../src/persistence/index.js';
import {} from '../../../src/work/index.js';
import { TestWorld } from '../support/world.js';

it('allows current-revision human acceptance through real merge authority', async () => {
  const world = new TestWorld();
  const translator = translatorFor(world);
  await appendObservation(world);
  await appendAcceptance(world, 'reviewer', ['reviewer']);
  await processInbound(translator, world);

  expect(await world.pullRequests.authorizeMerge(workId('2'), context(world))).toBe(true);
  expect(await world.events('pr.review-accepted')).toHaveLength(1);
});

it('accepts a GitHub approval without replicating repository permissions', async () => {
  const world = new TestWorld();
  const translator = translatorFor(world);
  await appendObservation(world);
  await appendAcceptance(world, 'outsider', []);
  await processInbound(translator, world);

  expect(await world.events('pr.review-accepted')).toHaveLength(1);
  expect(await world.events('pr.review-rejected')).toHaveLength(0);
});

function translatorFor(world: TestWorld, routing: WorkflowRouter = configureIntakeRouting(world)) {
  return new InboundTranslator(world.journal, world.work, world.resources, {
    pullRequests: world.pullRequests,
    ids: world.ids,
    lookup: world.resourceLookup,
    orchestration: world.orchestration,
    routing,
  });
}

function processInbound(translator: InboundTranslator, world: TestWorld) {
  return new EventProcessorHost(
    world.journal,
    world.checkpoints,
    createInMemoryProcessorRunSerialiser(),
  ).runOnce(translator.processor);
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
  const events = githubReviewObservation({
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
  const event = events.find((candidate) => candidate.payload.body === '/accepted');
  if (event === undefined) throw new Error('Approved GitHub review was not translated');
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

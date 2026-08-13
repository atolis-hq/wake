import { expect, it } from 'vitest';
import { PullRequestCheckState } from '../../../../src/activities/index.js';
import { integrationStream } from '../../../../src/integrations/contracts/streams.js';
import { createGitHubAgentContextReader } from '../../../../src/integrations/github/application/agent-context-reader.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import {
  correlationId,
  createEventDraft,
  EventActorKind,
  EventSourceKind,
} from '../../../../src/kernel/index.js';
import {
  resourceCapability,
  ResourceCorrelationRole,
  resourceKind,
} from '../../../../src/resources/index.js';
import { TestWorld } from '../../../e2e/support/world.js';

it('includes the latest correlated pull request check evidence without reading comments', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'repair the failing build' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000001' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
    capabilities: [resourceCapability('commentable')],
  });
  const pullRequest = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000002' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#8' },
    capabilities: [resourceCapability('commentable')],
  });
  const olderPullRequest = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000003' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#9' },
    capabilities: [resourceCapability('commentable')],
  });
  const context = {
    commandId: 'correlate-resource',
    correlationId: correlationId('agent-context'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    context,
  );
  await world.resources.correlate(
    pullRequest.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Secondary,
    { ...context, commandId: 'correlate-pull-request' },
  );
  await world.resources.correlate(
    olderPullRequest.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Secondary,
    { ...context, commandId: 'correlate-older-pull-request' },
  );
  const olderObservation = createEventDraft({
    eventId: 'github:pr:atolis-hq/wake#9:older',
    eventType: GitHubEventType.WorkObserved,
    occurredAt: '2026-08-14T00:00:00.000Z',
    correlationId: 'github:atolis-hq/wake#9',
    causationId: 'github:atolis-hq/wake#9:older',
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: GitHubAdapter },
    stream: integrationStream(GitHubAdapter),
    payload: {
      externalKey: 'atolis-hq/wake#9',
      kind: 'pull-request',
      title: 'Repair CI',
      body: 'The PR body',
      state: 'open',
      revision: 'head-9',
      headRevision: 'head-9',
      baseRevision: 'base-1',
      checks: PullRequestCheckState.Failing,
      actor: { id: 'author', kind: 'human' },
      raw: {
        number: 9,
        checkRuns: [{ id: 11, name: 'older', status: 'completed', conclusion: 'failure' }],
        statuses: [{ id: 12, context: 'deploy', state: 'failure' }],
      },
    },
  });
  const latestObservation = createEventDraft({
    ...olderObservation,
    eventId: 'github:pr:atolis-hq/wake#8:latest',
    correlationId: 'github:atolis-hq/wake#8',
    causationId: 'github:atolis-hq/wake#8:latest',
    payload: {
      ...olderObservation.payload,
      externalKey: 'atolis-hq/wake#8',
      revision: 'head-8',
      headRevision: 'head-8',
      raw: {
        number: 8,
        checkRuns: [
          'malformed historic evidence',
          ...Array.from({ length: 21 }, (_, index) => ({
            id: index + 1,
            name: `newest-${index + 1}`,
            status: 'completed',
            conclusion: 'failure',
            unexpected: 'x'.repeat(100_000),
          })),
        ],
        statuses: [
          { id: 22, context: 'deploy', state: 'failure', unexpected: 'x'.repeat(100_000) },
        ],
      },
    },
  });
  await world.journal.append(olderObservation.stream, 0, [olderObservation, latestObservation]);

  const agentContext = await createGitHubAgentContextReader(
    world.journal,
    world.resources,
  ).forWorkItem(work.workItemId);

  expect(agentContext).toMatchObject({
    title: '',
    body: '',
    comments: [],
    pullRequest: {
      checks: 'failing',
      statuses: [{ context: 'deploy', state: 'failure' }],
    },
  });
  expect(agentContext.pullRequest?.checkRuns).toHaveLength(20);
  expect(agentContext.pullRequest?.checkRuns.at(-1)).toEqual({
    name: 'newest-20',
    status: 'completed',
    conclusion: 'failure',
  });
});

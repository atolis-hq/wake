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
  const observation = createEventDraft({
    eventId: 'github:pr:atolis-hq/wake#8:latest',
    eventType: GitHubEventType.WorkObserved,
    occurredAt: '2026-08-14T00:00:00.000Z',
    correlationId: 'github:atolis-hq/wake#8',
    causationId: 'github:atolis-hq/wake#8:latest',
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: GitHubAdapter },
    stream: integrationStream(GitHubAdapter),
    payload: {
      externalKey: 'atolis-hq/wake#8',
      kind: 'pull-request',
      title: 'Repair CI',
      body: 'The PR body',
      state: 'open',
      revision: 'head-2',
      headRevision: 'head-2',
      baseRevision: 'base-1',
      checks: PullRequestCheckState.Failing,
      actor: { id: 'author', kind: 'human' },
      raw: {
        number: 8,
        checkRuns: [{ id: 11, name: 'unit', status: 'completed', conclusion: 'failure' }],
        statuses: [{ id: 12, context: 'deploy', state: 'failure' }],
      },
    },
  });
  await world.journal.append(observation.stream, 0, [observation]);

  await expect(
    createGitHubAgentContextReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual({
    title: '',
    body: '',
    comments: [],
    pullRequest: {
      checks: 'failing',
      checkRuns: [{ id: 11, name: 'unit', status: 'completed', conclusion: 'failure' }],
      statuses: [{ id: 12, context: 'deploy', state: 'failure' }],
    },
  });
});

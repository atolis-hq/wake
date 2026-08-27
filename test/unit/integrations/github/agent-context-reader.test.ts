import { expect, it } from 'vitest';
import { PullRequestCheckState } from '../../../../src/activities/index.js';
import {
  conversationIdForWorkItem,
  createConversationService,
} from '../../../../src/conversations/index.js';
import { integrationStream } from '../../../../src/integrations/contracts/streams.js';
import { createGitHubAgentContextReader } from '../../../../src/integrations/github/application/agent-context-reader.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { issueCommentObservation } from '../../../../src/integrations/github/infrastructure/issue-source.js';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
  deliveryStream,
} from '../../../../src/integrations/index.js';
import {
  correlationId,
  createEventDraft,
  EventActorKind,
  eventId,
  EventSourceKind,
} from '../../../../src/kernel/index.js';
import {
  resourceCapability,
  ResourceCorrelationRole,
  resourceKind,
  resourceStream,
  type ResourceId,
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

it('includes every eligible comment, human and Wake alike, within the character budget', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'keep current reviewer feedback' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000004' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-bounded-context',
      correlationId: correlationId('bounded-agent-context'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  for (let index = 1; index <= 14; index += 1)
    await appendIssueComment(world, index, `human feedback ${index}`);
  await appendIssueComment(world, 15, 'Wake status update\n<!-- wake:delivery:status-update -->');
  const reviewFeedback = [
    '<!-- wake:agent -->',
    '<!-- wake:delivery:review-verdict -->',
    '**Outcome:** 🔴 Changes Requested',
    'The current plan must retain the latest delivery cursor.',
  ].join('\n\n');
  await appendIssueComment(world, 16, reviewFeedback);
  const blockedHandoff = [
    '<!-- wake:agent -->',
    '<!-- wake:delivery:blocked-handoff -->',
    '**Outcome:** 🟠 Blocked',
    'The operator must provide the missing deployment credential.',
  ].join('\n\n');
  await appendIssueComment(world, 17, blockedHandoff);

  const context = await createGitHubAgentContextReader(world.journal, world.resources).forWorkItem(
    work.workItemId,
  );

  expect(context.comments).toHaveLength(17);
  expect(context.comments.map((comment) => comment.body)).toEqual([
    ...Array.from({ length: 14 }, (_, index) => `human feedback ${index + 1}`),
    'Wake status update\n<!-- wake:delivery:status-update -->',
    reviewFeedback,
    blockedHandoff,
  ]);
  expect(context.omittedComments).toBeUndefined();
});

it('truncates an individual comment that exceeds the per-comment cap', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'cap one oversized comment' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000005' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-oversized-comment',
      correlationId: correlationId('oversized-agent-context'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, 1, 'x'.repeat(9_000));

  const context = await createGitHubAgentContextReader(world.journal, world.resources).forWorkItem(
    work.workItemId,
  );

  expect(context.comments).toHaveLength(1);
  expect(context.comments[0]?.body).toHaveLength(8_000);
  expect(context.comments[0]?.body).toContain('truncated this historical comment');
  expect(context.omittedComments).toBeUndefined();
});

it('omits the oldest comments and reports how many once the overall budget is exceeded', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'exceed the overall character budget' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000006' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-exceeded-budget',
      correlationId: correlationId('exceeded-agent-context'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  const commentCount = 26;
  for (let index = 1; index <= commentCount; index += 1)
    await appendIssueComment(world, index, `${index}:${'x'.repeat(8_500)}`);

  const context = await createGitHubAgentContextReader(world.journal, world.resources).forWorkItem(
    work.workItemId,
  );

  expect(context.comments.length).toBeLessThan(commentCount);
  expect(context.omittedComments).toBe(commentCount - context.comments.length);
  expect(context.omittedComments).toBeGreaterThan(0);
  expect(context.comments[0]?.body.startsWith(`${commentCount}:`)).toBe(false);
  expect(context.comments.at(-1)?.body.startsWith(`${commentCount}:`)).toBe(true);
});

it("retains an earlier stage's Wake handoff after a later stage posts its own comment", async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'enable swimlanes per workflow' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000030' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#30' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-stage-handoff',
      correlationId: correlationId('stage-handoff-context'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendConfirmedAgentRunComment(world, issue.resourceId, {
    intentEventId: 'refine-plan',
    occurredAt: '2026-08-17T07:19:00.000Z',
    runId: 'run-refine-1',
    stage: 'refine',
    outcome: 'DONE',
    displayBody: 'Implementation plan: add a grouping control to the board.',
  });
  await appendConfirmedAgentRunComment(world, issue.resourceId, {
    intentEventId: 'review-failed',
    occurredAt: '2026-08-17T07:41:00.000Z',
    runId: 'run-review-1',
    stage: 'review',
    outcome: 'FAILED',
    displayBody: 'Unable to review: no plan was provided.',
  });

  const context = await createGitHubAgentContextReader(world.journal, world.resources).forWorkItem(
    work.workItemId,
  );

  expect(context.comments.map((comment) => comment.body).join('\n')).toContain(
    'Implementation plan: add a grouping control to the board.',
  );
  expect(context.comments.map((comment) => comment.body).join('\n')).toContain(
    'Unable to review: no plan was provided.',
  );
});

it('merges pre-conversation GitHub history with canonical conversation entries', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'retain historic discussion' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000031' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-history',
      correlationId: correlationId('historic-conversation-context'),
      occurredAt: '2026-08-17T00:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, 1, 'Historic GitHub discussion.');
  const conversations = createConversationService(world.journal);
  await conversations.createForWorkItem(work.workItemId, {
    commandId: 'create-conversation',
    correlationId: correlationId('historic-conversation-context'),
    occurredAt: '2026-08-17T01:00:00.000Z',
    actor: { kind: 'system', id: 'test' },
  });
  await conversations.record(
    {
      conversationId: conversationIdForWorkItem(work.workItemId),
      entryId: 'new-conversation-entry',
      body: 'New canonical discussion.',
      origin: { kind: 'control-plane', actorId: 'operator' },
    },
    {
      commandId: 'record-conversation-entry',
      correlationId: correlationId('historic-conversation-context'),
      occurredAt: '2026-08-17T02:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );

  const context = await createGitHubAgentContextReader(
    world.journal,
    world.resources,
    {},
    conversations,
  ).forWorkItem(work.workItemId);

  expect(context.comments.map((comment) => comment.body)).toEqual([
    'Historic GitHub discussion.',
    'New canonical discussion.',
  ]);
});

it('uses the revised canonical entry once when resuming after its initial GitHub observation', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'retain only the latest edited feedback' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000032' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-edited-history',
      correlationId: correlationId('edited-conversation-context'),
      occurredAt: '2026-08-17T00:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, 1, 'Original feedback.');
  await appendIssueComment(world, 1, 'Revised feedback.', '2026-08-17T00:02:00.000Z');
  const conversations = createConversationService(world.journal);
  const conversationId = conversationIdForWorkItem(work.workItemId);
  const context = {
    commandId: 'edited-conversation',
    correlationId: correlationId('edited-conversation-context'),
    occurredAt: '2026-08-17T00:01:00.000Z',
    actor: { kind: 'system' as const, id: 'test' },
  };
  await conversations.createForWorkItem(work.workItemId, context);
  await conversations.record(
    {
      conversationId,
      entryId: 'external-comment-1',
      body: 'Original feedback.',
      origin: {
        kind: 'external',
        adapter: GitHubAdapter,
        actorId: 'reviewer-1',
        resourceId: issue.resourceId,
        threadId: 'atolis-hq/wake#10',
        messageId: '1',
      },
    },
    context,
  );
  await conversations.revise(
    { conversationId, entryId: 'external-comment-1', body: 'Revised feedback.' },
    { ...context, commandId: 'revise-external-comment', occurredAt: '2026-08-17T00:02:00.000Z' },
  );

  const agentContext = await createGitHubAgentContextReader(
    world.journal,
    world.resources,
    {},
    conversations,
  ).forWorkItem(work.workItemId);

  expect(agentContext.comments.map((comment) => comment.body)).toEqual(['Revised feedback.']);

  const resumedAgentContext = await createGitHubAgentContextReader(
    world.journal,
    world.resources,
    {},
    conversations,
  ).forWorkItem(work.workItemId, { observedSince: '2026-08-17T00:01:30.000Z' });

  expect(resumedAgentContext.comments.map((comment) => comment.body)).toEqual([
    'Revised feedback.',
  ]);
});

it('does not restore a tombstoned canonical GitHub comment from legacy history', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'exclude deleted reviewer feedback' });
  const issue = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000033' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#10' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    issue.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-tombstoned-history',
      correlationId: correlationId('tombstoned-conversation-context'),
      occurredAt: '2026-08-17T00:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, 2, 'Deleted feedback.');
  const conversations = createConversationService(world.journal);
  const conversationId = conversationIdForWorkItem(work.workItemId);
  const context = {
    commandId: 'tombstoned-conversation',
    correlationId: correlationId('tombstoned-conversation-context'),
    occurredAt: '2026-08-17T00:01:00.000Z',
    actor: { kind: 'system' as const, id: 'test' },
  };
  await conversations.createForWorkItem(work.workItemId, context);
  await conversations.record(
    {
      conversationId,
      entryId: 'external-comment-2',
      body: 'Deleted feedback.',
      origin: {
        kind: 'external',
        adapter: GitHubAdapter,
        actorId: 'reviewer-2',
        resourceId: issue.resourceId,
        threadId: 'atolis-hq/wake#10',
        messageId: '2',
      },
    },
    context,
  );
  await conversations.tombstone(
    { conversationId, entryId: 'external-comment-2' },
    { ...context, commandId: 'tombstone-external-comment', occurredAt: '2026-08-17T00:02:00.000Z' },
  );

  const agentContext = await createGitHubAgentContextReader(
    world.journal,
    world.resources,
    {},
    conversations,
  ).forWorkItem(work.workItemId);

  expect(agentContext.comments).toEqual([]);
});

it('uses only active conversation entries after the resume cutoff and preserves inline locations', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'resume with current inline feedback' });
  const conversations = createConversationService(world.journal);
  const conversationId = conversationIdForWorkItem(work.workItemId);
  const context = {
    commandId: 'conversation-context',
    correlationId: correlationId('conversation-context'),
    occurredAt: '2026-08-17T00:00:00.000Z',
    actor: { kind: 'system' as const, id: 'test' },
  };
  await conversations.createForWorkItem(work.workItemId, context);
  await conversations.record(
    {
      conversationId,
      entryId: 'before-cutoff',
      body: 'Do not include this earlier message.',
      origin: { kind: 'control-plane', actorId: 'operator' },
    },
    context,
  );
  await conversations.record(
    {
      conversationId,
      entryId: 'inline-feedback',
      body: 'Retain this inline feedback.',
      origin: {
        kind: 'external',
        adapter: GitHubAdapter,
        actorId: 'reviewer',
        resourceId: 'resource-00000000000000000000000040',
        threadId: 'atolis-hq/wake#40',
        messageId: '40',
        location: { path: 'src/current.ts', line: 41, side: 'RIGHT' },
      },
    },
    { ...context, commandId: 'inline-feedback', occurredAt: '2026-08-17T01:00:00.000Z' },
  );
  await conversations.record(
    {
      conversationId,
      entryId: 'deleted-feedback',
      body: 'Do not include this deleted message.',
      origin: { kind: 'control-plane', actorId: 'operator' },
    },
    { ...context, commandId: 'deleted-feedback', occurredAt: '2026-08-17T01:01:00.000Z' },
  );
  await conversations.tombstone(
    { conversationId, entryId: 'deleted-feedback' },
    { ...context, commandId: 'delete-feedback', occurredAt: '2026-08-17T01:02:00.000Z' },
  );

  const reader = createGitHubAgentContextReader(world.journal, world.resources, {}, conversations);
  const agentContext = await reader.forWorkItem(work.workItemId, {
    observedSince: '2026-08-17T00:30:00.000Z',
  });

  expect(agentContext.comments).toEqual([
    {
      author: 'reviewer',
      occurredAt: '2026-08-17T01:00:00.000Z',
      body: 'Retain this inline feedback.',
      location: { path: 'src/current.ts', line: 41, side: 'RIGHT' },
    },
  ]);
});

async function appendConfirmedAgentRunComment(
  world: TestWorld,
  resourceId: ResourceId,
  input: {
    readonly intentEventId: string;
    readonly occurredAt: string;
    readonly runId: string;
    readonly stage: string;
    readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
    readonly displayBody: string;
  },
): Promise<void> {
  const intent = createEventDraft({
    eventId: input.intentEventId,
    eventType: DeliveryIntentEventType.AgentRunPublishRequested,
    occurredAt: input.occurredAt,
    correlationId: `correlation:${input.intentEventId}`,
    causationId: `causation:${input.intentEventId}`,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: resourceStream(resourceId),
    payload: {
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      resourceId,
      report: {
        runId: input.runId,
        stage: input.stage,
        startedAt: input.occurredAt,
        finishedAt: input.occurredAt,
        displayBody: input.displayBody,
        outcome: input.outcome,
        metadata: {},
      },
    },
  });
  const stream = resourceStream(resourceId);
  const [published] = await world.journal.append(
    stream,
    (await world.journal.readStream(stream)).length,
    [intent],
  );
  if (published === undefined) throw new Error('Expected agent-run publication intent');
  const confirmation = createEventDraft({
    eventId: `${input.intentEventId}-confirmed`,
    eventType: DeliveryEventType.Confirmed,
    occurredAt: input.occurredAt,
    correlationId: `correlation:${input.intentEventId}`,
    causationId: `causation:${input.intentEventId}`,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: deliveryStream(eventId(input.intentEventId)),
    payload: {
      intentEventId: eventId(input.intentEventId),
      intentGlobalPosition: published.globalPosition,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
      externalId: `github-comment-${input.intentEventId}`,
    },
  });
  await world.journal.append(confirmation.stream, 0, [confirmation]);
}

async function appendIssueComment(world: TestWorld, id: number, body: string, updatedAt?: string) {
  const createdAt = `2026-08-17T00:${String(id).padStart(2, '0')}:00.000Z`;
  const event = issueCommentObservation({
    repository: 'atolis-hq/wake',
    adapter: GitHubAdapter,
    issue: { number: 10 },
    comment: {
      id,
      body,
      created_at: createdAt,
      updated_at: updatedAt ?? createdAt,
      user: { login: `reviewer-${id}`, type: 'User' },
    },
  });
  if (event === null) throw new Error('Expected issue comment observation');
  const events = await world.journal.readStream(event.stream);
  await world.journal.append(event.stream, events.length, [event]);
}

import { expect, it } from 'vitest';
import { adapterId } from '../../../../src/integrations/contracts/identifiers.js';
import { createCommentHistoryReader } from '../../../../src/integrations/github/application/comment-history-reader.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { issueCommentObservation } from '../../../../src/integrations/github/infrastructure/issue-source.js';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
  DeliveryResultKind,
  deliveryStream,
} from '../../../../src/integrations/index.js';
import {
  correlationId,
  createEventData,
  eventId,
  type EventData,
} from '../../../../src/kernel/index.js';
import {
  resourceCapability,
  ResourceCorrelationRole,
  resourceKind,
  resourceStream,
  type ResourceId,
} from '../../../../src/resources/index.js';
import { TestWorld } from '../../../e2e/support/world.js';

it("returns the primary correlated resource's comments in journal order", async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'remember reviewer feedback' });
  const resource = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000000' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    resource.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-primary-resource',
      correlationId: correlationId('comment-history'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );

  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'first',
    author: 'a',
    updatedAt: '2026-08-08T00:00:00.000Z',
  });
  await appendIssueComment(world, {
    issueNumber: 8,
    id: 2,
    body: 'unrelated',
    author: 'other',
    updatedAt: '2026-08-08T00:01:00.000Z',
  });
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 3,
    body: 'second',
    author: 'b',
    updatedAt: '2026-08-08T00:02:00.000Z',
    location: { path: 'src/example.ts', line: 42, side: 'RIGHT' },
  });

  const reader = createCommentHistoryReader(world.journal, world.resources);

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([
    { author: 'a', occurredAt: '2026-08-08T00:00:00.000Z', body: 'first' },
    {
      author: 'b',
      occurredAt: '2026-08-08T00:02:00.000Z',
      body: 'second',
      location: { path: 'src/example.ts', line: 42, side: 'RIGHT' },
    },
  ]);
});

it('includes feedback from every GitHub resource correlated to the work item', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'revise from PR feedback' });
  for (const [number, suffix] of [
    [7, '0'],
    [8, '1'],
  ] as const) {
    const resource = await world.discoverResource({
      resourceId: `resource-${'0'.repeat(25)}${suffix}` as never,
      kind: resourceKind(number === 7 ? 'issue' : 'pull-request'),
      externalKey: { adapter: GitHubAdapter, key: `atolis-hq/wake#${number}` },
      capabilities: [resourceCapability('commentable')],
    });
    await world.resources.correlate(
      resource.resourceId,
      work.workItemId,
      ResourceCorrelationRole.Primary,
      {
        commandId: `correlate-${number}`,
        correlationId: correlationId(`comment-history-${number}`),
        occurredAt: world.clock.now().toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );
  }
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'original request',
    author: 'author',
    updatedAt: '2026-08-08T00:00:00.000Z',
  });
  await appendIssueComment(world, {
    issueNumber: 8,
    id: 2,
    body: 'please revise this branch',
    author: 'reviewer',
    updatedAt: '2026-08-08T00:01:00.000Z',
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual([
    { author: 'author', occurredAt: '2026-08-08T00:00:00.000Z', body: 'original request' },
    {
      author: 'reviewer',
      occurredAt: '2026-08-08T00:01:00.000Z',
      body: 'please revise this branch',
    },
  ]);
});

it('returns only correlated comments observed after a resume boundary', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'resume from new feedback' });
  for (const [number, suffix] of [
    [7, '0'],
    [8, '1'],
  ] as const) {
    const resource = await world.discoverResource({
      resourceId: `resource-${'0'.repeat(25)}${suffix}` as never,
      kind: resourceKind(number === 7 ? 'issue' : 'pull-request'),
      externalKey: { adapter: GitHubAdapter, key: `atolis-hq/wake#${number}` },
      capabilities: [resourceCapability('commentable')],
    });
    await world.resources.correlate(
      resource.resourceId,
      work.workItemId,
      ResourceCorrelationRole.Primary,
      {
        commandId: `correlate-${number}`,
        correlationId: correlationId(`resume-comment-${number}`),
        occurredAt: world.clock.now().toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );
  }
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'already seen',
    author: 'author',
    updatedAt: '2026-08-08T00:00:00.000Z',
  });
  await appendIssueComment(world, {
    issueNumber: 8,
    id: 2,
    body: 'new review feedback',
    author: 'reviewer',
    updatedAt: '2026-08-08T00:02:00.000Z',
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId, {
      observedSince: '2026-08-08T00:01:00.000Z',
    }),
  ).resolves.toEqual([
    { author: 'reviewer', occurredAt: '2026-08-08T00:02:00.000Z', body: 'new review feedback' },
  ]);
});

it('returns an empty list when there is no primary correlation', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'no resource yet' });
  const reader = createCommentHistoryReader(world.journal, world.resources);

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([]);
});

it('does not use GitHub comments for a primary resource from another adapter', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'keep sources distinct' });
  const resource = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000000' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'another-adapter', key: 'atolis-hq/wake#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    resource.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-other-adapter-resource',
      correlationId: correlationId('comment-history'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'not from this resource',
    author: 'a',
    updatedAt: '2026-08-08T00:00:00.000Z',
  });
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'non-github-status',
    eventType: DeliveryIntentEventType.StatusPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'This delivery belongs to another provider.',
  });

  const reader = createCommentHistoryReader(world.journal, world.resources);

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([]);
});

it('reads comments from a GitHub provider alias stream', async () => {
  const world = new TestWorld();
  const alias = adapterId('github-secondary');
  const work = await world.createWork({ objective: 'remember aliased GitHub feedback' });
  const resource = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000000' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: alias, key: 'atolis-hq/wake#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    resource.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-aliased-github-resource',
      correlationId: correlationId('comment-history'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'aliased feedback',
    author: 'a',
    updatedAt: '2026-08-08T00:00:00.000Z',
    adapter: alias,
  });
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'aliased-github-status',
    eventType: DeliveryIntentEventType.StatusPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'Wake is working on the aliased resource.',
  });

  const reader = createCommentHistoryReader(world.journal, world.resources, {
    githubAdapters: [alias],
  });

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([
    { author: 'a', occurredAt: '2026-08-08T00:00:00.000Z', body: 'aliased feedback' },
    {
      author: 'unknown-github-identity',
      occurredAt: '2026-08-08T00:02:00.000Z',
      body: 'Wake is working on the aliased resource.\n<!-- wake:delivery:aliased-github-status -->',
    },
  ]);
});

it('includes a confirmed status delivery before GitHub polling observes it', async () => {
  const { world, work, resource } = await correlatedGitHubWork();
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'status-comment',
    eventType: DeliveryIntentEventType.StatusPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: '  Wake has started work.  ',
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual([
    {
      author: 'unknown-github-identity',
      occurredAt: '2026-08-08T00:02:00.000Z',
      body: 'Wake has started work.  \n<!-- wake:delivery:status-comment -->',
    },
  ]);
});

it('replaces a confirmed synthetic comment with its polled comment before applying observedSince', async () => {
  const { world, work, resource } = await correlatedGitHubWork();
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'reply-comment',
    eventType: DeliveryIntentEventType.ReplyPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'Acknowledged.',
  });
  await appendIssueComment(world, {
    issueNumber: 7,
    id: 1,
    body: 'Acknowledged.\n<!-- wake:delivery:reply-comment -->',
    author: 'wake-bot',
    updatedAt: '2026-08-08T00:03:00.000Z',
  });

  const reader = createCommentHistoryReader(world.journal, world.resources);
  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([
    {
      author: 'wake-bot',
      occurredAt: '2026-08-08T00:03:00.000Z',
      body: 'Acknowledged.\n<!-- wake:delivery:reply-comment -->',
    },
  ]);
  await expect(
    reader.forWorkItem(work.workItemId, { observedSince: '2026-08-08T00:02:30.000Z' }),
  ).resolves.toEqual([]);
});

it('does not reconcile a delivery with a marker observed on another correlated resource', async () => {
  const { world, work, resource } = await correlatedGitHubWork();
  const other = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000001' as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#8' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    other.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-other-primary-resource',
      correlationId: correlationId('other-confirmed-comment-history'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'status-for-issue-seven',
    eventType: DeliveryIntentEventType.StatusPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'Status for issue seven',
  });
  await appendIssueComment(world, {
    issueNumber: 8,
    id: 1,
    body: 'A copied marker\n<!-- wake:delivery:status-for-issue-seven -->',
    author: 'reviewer',
    updatedAt: '2026-08-08T00:03:00.000Z',
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual([
    {
      author: 'unknown-github-identity',
      occurredAt: '2026-08-08T00:02:00.000Z',
      body: 'Status for issue seven\n<!-- wake:delivery:status-for-issue-seven -->',
    },
    {
      author: 'reviewer',
      occurredAt: '2026-08-08T00:03:00.000Z',
      body: 'A copied marker\n<!-- wake:delivery:status-for-issue-seven -->',
    },
  ]);
});

it('includes a reply whose ambiguous delivery was reconciled as confirmed', async () => {
  const { world, work, resource } = await correlatedGitHubWork();
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'reconciled-reply',
    eventType: DeliveryIntentEventType.ReplyPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'Recovered delivery.',
    reconciled: true,
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual([
    {
      author: 'unknown-github-identity',
      occurredAt: '2026-08-08T00:02:00.000Z',
      body: 'Recovered delivery.\n<!-- wake:delivery:reconciled-reply -->',
    },
  ]);
});

it('excludes an unconfirmed comment-shaped delivery intent', async () => {
  const { world, work, resource } = await correlatedGitHubWork();
  await appendConfirmedDelivery(world, resource.resourceId, {
    intentEventId: 'pending-status',
    eventType: DeliveryIntentEventType.StatusPublishRequested,
    occurredAt: '2026-08-08T00:01:00.000Z',
    body: 'This must not appear yet.',
    confirmed: false,
  });

  await expect(
    createCommentHistoryReader(world.journal, world.resources).forWorkItem(work.workItemId),
  ).resolves.toEqual([]);
});

async function correlatedGitHubWork() {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'show Wake delivery immediately' });
  const resource = await world.discoverResource({
    resourceId: 'resource-00000000000000000000000000' as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(
    resource.resourceId,
    work.workItemId,
    ResourceCorrelationRole.Primary,
    {
      commandId: 'correlate-primary-resource',
      correlationId: correlationId('confirmed-comment-history'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    },
  );
  return { world, work, resource };
}

async function appendConfirmedDelivery(
  world: TestWorld,
  resourceId: ResourceId,
  input: {
    readonly intentEventId: string;
    readonly eventType:
      | typeof DeliveryIntentEventType.StatusPublishRequested
      | typeof DeliveryIntentEventType.ReplyPublishRequested;
    readonly occurredAt: string;
    readonly body: string;
    readonly reconciled?: boolean;
    readonly confirmed?: boolean;
  },
) {
  const intent = await appendEvent(
    world,
    createEventData({
      eventId: input.intentEventId,
      eventType: input.eventType,
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
        body: input.body,
      },
    }),
  );
  if (input.confirmed === false) return intent;
  const delivery = (payload: {
    readonly externalId: string;
    readonly result?: typeof DeliveryResultKind.Confirmed;
  }) => ({
    eventId: `${input.intentEventId}-confirmed`,
    occurredAt: '2026-08-08T00:02:00.000Z',
    correlationId: `correlation:${input.intentEventId}`,
    causationId: `causation:${input.intentEventId}`,
    actor: { kind: 'system' as const, id: 'test' },
    source: { kind: 'internal' as const, id: 'test' },
    stream: deliveryStream(eventId(input.intentEventId)),
    payload: {
      intentEventId: eventId(input.intentEventId),
      intentGlobalPosition: intent.globalPosition,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
      ...payload,
    },
  });
  return appendEvent(
    world,
    input.reconciled === true
      ? createEventData({
          ...delivery({ externalId: 'github-comment-1', result: DeliveryResultKind.Confirmed }),
          eventType: DeliveryEventType.Reconciled,
        })
      : createEventData({
          ...delivery({ externalId: 'github-comment-1' }),
          eventId: `${input.intentEventId}-confirmed`,
          eventType: DeliveryEventType.Confirmed,
        }),
  );
}

async function appendEvent(world: TestWorld, event: EventData) {
  const events = await world.journal.readStream(event.stream);
  const [appended] = await world.journal.appendToStream(event.stream, events.length, [event]);
  if (appended === undefined) throw new Error('Expected the journal to append an event');
  return appended;
}

async function appendIssueComment(
  world: TestWorld,
  input: {
    readonly issueNumber: number;
    readonly id: number;
    readonly body: string;
    readonly author: string;
    readonly updatedAt: string;
    readonly location?: {
      readonly path: string;
      readonly line: number;
      readonly side: 'LEFT' | 'RIGHT';
    };
    readonly adapter?: typeof GitHubAdapter;
  },
): Promise<void> {
  const { issueNumber, id, body, author, updatedAt, location, adapter = GitHubAdapter } = input;
  const event = issueCommentObservation({
    repository: 'atolis-hq/wake',
    adapter,
    issue: { number: issueNumber },
    comment: {
      id,
      body,
      created_at: updatedAt,
      updated_at: updatedAt,
      user: { login: author, type: 'User' },
      ...(location === undefined ? {} : location),
    },
  });
  if (event === null) throw new Error('Test comment observation was unexpectedly empty');
  const events = await world.journal.readStream(event.stream);
  await world.journal.appendToStream(event.stream, events.length, [event]);
}

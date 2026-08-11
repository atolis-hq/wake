import { expect, it } from 'vitest';
import { adapterId } from '../../../../src/integrations/contracts/identifiers.js';
import { createCommentHistoryReader } from '../../../../src/integrations/github/application/comment-history-reader.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { issueCommentObservation } from '../../../../src/integrations/github/infrastructure/issue-source.js';
import { correlationId } from '../../../../src/kernel/index.js';
import {
  resourceCapability,
  ResourceCorrelationRole,
  resourceKind,
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
  });

  const reader = createCommentHistoryReader(world.journal, world.resources);

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([
    { author: 'a', occurredAt: '2026-08-08T00:00:00.000Z', body: 'first' },
    { author: 'b', occurredAt: '2026-08-08T00:02:00.000Z', body: 'second' },
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

  const reader = createCommentHistoryReader(world.journal, world.resources);

  await expect(reader.forWorkItem(work.workItemId)).resolves.toEqual([
    { author: 'a', occurredAt: '2026-08-08T00:00:00.000Z', body: 'aliased feedback' },
  ]);
});

async function appendIssueComment(
  world: TestWorld,
  input: {
    readonly issueNumber: number;
    readonly id: number;
    readonly body: string;
    readonly author: string;
    readonly updatedAt: string;
    readonly adapter?: typeof GitHubAdapter;
  },
): Promise<void> {
  const { issueNumber, id, body, author, updatedAt, adapter = GitHubAdapter } = input;
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
    },
  });
  if (event === null) throw new Error('Test comment observation was unexpectedly empty');
  const events = await world.journal.readStream(event.stream);
  await world.journal.append(event.stream, events.length, [event]);
}

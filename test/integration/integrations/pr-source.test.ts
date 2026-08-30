import { beforeEach, expect, it, vi } from 'vitest';
import {} from '../../support/identities.js';

import { createPullRequestService } from '../../../src/activities/index.js';
import { EventProcessorHost } from '../../../src/eventing/index.js';
import {
  InboundTranslator,
  PollService,
  createGitHubClient,
  createGitHubPullRequestSource,
  type GitHubPullRequestSourceClient,
} from '../../../src/integrations/github/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '../../../src/persistence/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  createResourceLookup,
  createResourceService,
} from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

const octokit = vi.hoisted(() => ({
  paginate: vi.fn(),
  paginateIterator: vi.fn(),
  listPullRequests: vi.fn(),
  listCheckRunsForRef: vi.fn(),
  getCombinedStatusForRef: vi.fn(),
  listPullRequestFiles: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      paginate: Object.assign(octokit.paginate, { iterator: octokit.paginateIterator }),
      rest: {
        pulls: { list: octokit.listPullRequests, listFiles: octokit.listPullRequestFiles },
        checks: { listForRef: octokit.listCheckRunsForRef },
        repos: { getCombinedStatusForRef: octokit.getCombinedStatusForRef },
        issues: { listForRepo: vi.fn() },
        users: { getAuthenticated: vi.fn() },
      },
    };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  octokit.paginateIterator.mockImplementation((endpoint) =>
    endpoint === octokit.listPullRequests
      ? pagesOf({ data: [pullRequest()] })
      : pagesOf({ data: [] }),
  );
});

it('stops PR pagination at maxResults and reads every check-run page', async () => {
  octokit.paginateIterator.mockImplementation((endpoint) => {
    if (endpoint === octokit.listPullRequests)
      return pagesOf(
        { data: [pullRequest(), { ...pullRequest(), number: 8 }] },
        {
          data: [
            { ...pullRequest(), number: 9 },
            { ...pullRequest(), number: 10 },
          ],
        },
      );
    return pagesOf(
      { data: Array.from({ length: 100 }, (_, id) => ({ id })) },
      { data: Array.from({ length: 25 }, (_, id) => ({ id: id + 100 })) },
    );
  });
  octokit.getCombinedStatusForRef
    .mockResolvedValueOnce({
      data: {
        total_count: 125,
        statuses: Array.from({ length: 100 }, (_, id) => ({ id })),
      },
    })
    .mockResolvedValueOnce({
      data: {
        total_count: 125,
        statuses: Array.from({ length: 25 }, (_, id) => ({ id: id + 100 })),
      },
    });
  const client = createGitHubClient('token');

  const pullRequests = await client.listPullRequests('owner', 'repo', 3);
  const checkRuns = await client.listCheckRunsForRef('owner', 'repo', 'head-a');
  const statuses = await client.getCombinedStatusForRef('owner', 'repo', 'head-a');

  expect(pullRequests).toHaveLength(3);
  expect(checkRuns).toHaveLength(125);
  expect(statuses).toHaveLength(125);
});

it('lists every page of changed file paths for a pull request', async () => {
  octokit.paginateIterator.mockImplementation((endpoint) =>
    endpoint === octokit.listPullRequestFiles
      ? pagesOf(
          { data: [{ filename: 'a.ts' }, { filename: 'b.ts' }] },
          { data: [{ filename: 'c.ts' }] },
        )
      : pagesOf({ data: [] }),
  );
  const client = createGitHubClient('token');

  await expect(client.listPullRequestFiles('owner', 'repo', 7)).resolves.toEqual([
    'a.ts',
    'b.ts',
    'c.ts',
  ]);
  expect(octokit.paginateIterator).toHaveBeenCalledWith(octokit.listPullRequestFiles, {
    owner: 'owner',
    repo: 'repo',
    pull_number: 7,
    per_page: 100,
  });
});

it('requests no more than the nested result limit in one GitHub evidence page', async () => {
  octokit.getCombinedStatusForRef.mockResolvedValue({ data: { total_count: 0, statuses: [] } });
  const client = createGitHubClient('token');

  await client.listPullRequestFiles('owner', 'repo', 7, 2);
  await client.listCheckRunsForRef('owner', 'repo', 'head-a', 2);
  await client.getCombinedStatusForRef('owner', 'repo', 'head-a', 2);

  expect(octokit.paginateIterator).toHaveBeenCalledWith(octokit.listPullRequestFiles, {
    owner: 'owner',
    repo: 'repo',
    pull_number: 7,
    per_page: 2,
  });
  expect(octokit.paginateIterator).toHaveBeenCalledWith(octokit.listCheckRunsForRef, {
    owner: 'owner',
    repo: 'repo',
    ref: 'head-a',
    per_page: 2,
  });
  expect(octokit.getCombinedStatusForRef).toHaveBeenCalledWith({
    owner: 'owner',
    repo: 'repo',
    ref: 'head-a',
    per_page: 2,
    page: 1,
  });
});

it('conditionally polls check runs for an unchanged head revision', async () => {
  let attempts = 0;
  const requests: unknown[] = [];
  octokit.paginateIterator.mockImplementation((endpoint, parameters) => {
    if (endpoint !== octokit.listCheckRunsForRef) return pagesOf({ data: [] });
    requests.push(parameters);
    attempts += 1;
    return attempts === 1
      ? pagesOf({ data: [{ id: 1 }], headers: { etag: '"checks-v1"' } })
      : notModifiedPages();
  });
  const client = createGitHubClient('token');

  await expect(client.listCheckRunsForRef('owner', 'repo', 'head-a')).resolves.toEqual([{ id: 1 }]);
  await expect(client.listCheckRunsForRef('owner', 'repo', 'head-a')).resolves.toEqual([{ id: 1 }]);

  expect(requests).toEqual([
    { owner: 'owner', repo: 'repo', ref: 'head-a', per_page: 100 },
    {
      owner: 'owner',
      repo: 'repo',
      ref: 'head-a',
      per_page: 100,
      headers: { 'if-none-match': '"checks-v1"' },
    },
  ]);
});

it('conditionally polls combined status for an unchanged head revision', async () => {
  octokit.getCombinedStatusForRef
    .mockResolvedValueOnce({
      data: { total_count: 1, statuses: [{ id: 1 }] },
      headers: { etag: '"status-v1"' },
    })
    .mockRejectedValueOnce(Object.assign(new Error('not modified'), { status: 304 }));
  const client = createGitHubClient('token');

  await expect(client.getCombinedStatusForRef('owner', 'repo', 'head-a')).resolves.toEqual([
    { id: 1 },
  ]);
  await expect(client.getCombinedStatusForRef('owner', 'repo', 'head-a')).resolves.toEqual([
    { id: 1 },
  ]);

  expect(octokit.getCombinedStatusForRef).toHaveBeenNthCalledWith(2, {
    owner: 'owner',
    repo: 'repo',
    ref: 'head-a',
    per_page: 100,
    page: 1,
    headers: { 'if-none-match': '"status-v1"' },
  });
});

it.each([
  ['pending', [{ status: 'in_progress', conclusion: null }], [{ state: 'success' }]],
  ['passing', [{ status: 'completed', conclusion: 'success' }], [{ state: 'success' }]],
  ['failing', [{ status: 'completed', conclusion: 'failure' }], [{ state: 'pending' }]],
] as const)(
  'queries real head evidence and normalizes %s with failure-first precedence',
  async (expected, checkRuns, statuses) => {
    octokit.paginateIterator.mockImplementation((endpoint) => {
      if (endpoint === octokit.listPullRequests) return pagesOf({ data: [pullRequest()] });
      if (endpoint === octokit.listPullRequestFiles) return pagesOf({ data: [] });
      return pagesOf({ data: checkRuns });
    });
    octokit.getCombinedStatusForRef.mockResolvedValue({ data: { statuses } });
    const source = createGitHubPullRequestSource({
      client: createGitHubClient('token'),
      repository: 'owner/repo',
      maxResults: 10,
    });

    const [event] = await source.poll(new AbortController().signal);

    expect(octokit.paginateIterator).toHaveBeenCalledWith(octokit.listPullRequests, {
      owner: 'owner',
      repo: 'repo',
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    });
    expect(octokit.paginateIterator).toHaveBeenCalledWith(octokit.listCheckRunsForRef, {
      owner: 'owner',
      repo: 'repo',
      ref: 'head-a',
      per_page: 10,
    });
    expect(octokit.getCombinedStatusForRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'head-a',
      per_page: 10,
      page: 1,
    });
    expect(event?.payload).toMatchObject({
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: expected,
      raw: { checkRuns, statuses },
    });
  },
);

it('emits changed check evidence when GitHub checks change without PR metadata changing', async () => {
  const checkRuns = [
    [{ id: 1, status: 'in_progress', conclusion: null }],
    [{ id: 1, status: 'completed', conclusion: 'success' }],
  ];
  const client = fakeClient({
    checkRuns: async () => checkRuns.shift() ?? [],
    statuses: async () => [{ state: 'success' }],
  });
  const runtime = sourceRuntime(client);
  const { journal, checkpoints, lookup, translator, poll, pullRequests } = runtime;
  await admitPullRequest(runtime, 'checks-changed', 'owner/repo#7');

  await poll.pollOnce(new AbortController().signal);
  await processInbound(translator, journal, checkpoints);
  await poll.pollOnce(new AbortController().signal);
  await processInbound(translator, journal, checkpoints);

  const resource = await lookup.resourceIdForExternalKey({
    adapter: 'github',
    key: 'owner/repo#7',
  });
  expect(resource).not.toBeNull();
  expect((await pullRequests.get(resource!))?.checks).toBe('passing');
  expect((await journal.readAll(0)).map((event) => event.event.eventType)).toContain(
    'pr.checks-changed',
  );
});

it('distinguishes pending to passing to a new pending run and deduplicates identical repolls', async () => {
  const checkRuns = [
    [{ id: 1, status: 'in_progress', conclusion: null, started_at: '2026-07-30T12:00:01Z' }],
    [
      {
        id: 1,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-30T12:00:01Z',
        completed_at: '2026-07-30T12:00:02Z',
      },
    ],
    [{ id: 2, status: 'queued', conclusion: null, started_at: '2026-07-30T12:00:03Z' }],
    [{ id: 2, status: 'queued', conclusion: null, started_at: '2026-07-30T12:00:03Z' }],
  ];
  const client = fakeClient({
    checkRuns: async () => checkRuns.shift() ?? [],
    statuses: async () => [{ id: 1, context: 'legacy', state: 'success' }],
  });
  const runtime = sourceRuntime(client);
  const { journal, checkpoints, lookup, translator, poll, pullRequests } = runtime;
  await admitPullRequest(runtime, 'pending-passing-pending', 'owner/repo#7');

  for (let index = 0; index < 4; index += 1) {
    await poll.pollOnce(new AbortController().signal);
    await processInbound(translator, journal, checkpoints);
  }

  expect(
    (await journal.readAll(0)).filter(
      (event) => event.event.eventType === 'integration.github.work-observed',
    ),
  ).toHaveLength(3);
  const resource = await lookup.resourceIdForExternalKey({
    adapter: 'github',
    key: 'owner/repo#7',
  });
  expect(resource).not.toBeNull();
  expect((await pullRequests.get(resource!))?.checks).toBe('pending');
});

it('distinguishes a base-only provider evidence change', async () => {
  const pullRequests = [pullRequest(), { ...pullRequest(), base: { sha: 'base-b' } }];
  const client = fakeClient({
    pullRequests: async () => [pullRequests.shift() ?? pullRequest()],
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const first = await source.poll(new AbortController().signal);
  const second = await source.poll(new AbortController().signal);

  expect(first[0]?.eventId).not.toBe(second[0]?.eventId);
  expect(second[0]?.payload).toMatchObject({ baseRevision: 'base-b' });
});

it('normalizes a merged GitHub pull request to merged public state', async () => {
  const client = fakeClient({
    pullRequests: async () => [
      { ...pullRequest(), state: 'closed', merged_at: '2026-07-30T12:05:00.000Z' },
    ],
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const [event] = await source.poll(new AbortController().signal);

  expect(event?.payload).toMatchObject({ state: 'merged' });
});

it('fails checks closed to unknown when either evidence endpoint is unavailable', async () => {
  const client = fakeClient({
    checkRuns: async () => [{ id: 1, status: 'completed', conclusion: 'success' }],
    statuses: async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    },
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const [event] = await source.poll(new AbortController().signal);

  expect(event?.payload).toMatchObject({ checks: 'unknown' });
});

it('reports the changed file paths for a pull request', async () => {
  const client = fakeClient({
    changedFiles: async () => ['src/example.ts', 'docs/example.md'],
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const [event] = await source.poll(new AbortController().signal);

  expect(event?.payload).toMatchObject({
    changedFiles: ['src/example.ts', 'docs/example.md'],
  });
});

it('omits changed files rather than failing the observation when the provider call errors', async () => {
  const client = fakeClient({
    changedFiles: async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    },
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const [event] = await source.poll(new AbortController().signal);

  expect(event?.payload).not.toHaveProperty('changedFiles');
});

it('bounds persisted diagnostic check evidence before recording the observation', async () => {
  const client = fakeClient({
    checkRuns: async () =>
      Array.from({ length: 21 }, (_, index) => ({
        name: `check-${index + 1}`,
        status: 'completed',
        conclusion: 'failure',
        details_url: 'x'.repeat(100_000),
        unexpected: 'do not persist',
      })),
    statuses: async () => [
      { context: 'deploy', state: 'failure', target_url: 'x'.repeat(100_000) },
    ],
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 10,
  });

  const [event] = await source.poll(new AbortController().signal);
  if (event?.eventType !== 'integration.github.work-observed')
    throw new Error('Expected a GitHub work observation');
  const raw = event.payload.raw as {
    readonly checkRuns: readonly Record<string, unknown>[];
    readonly statuses: readonly Record<string, unknown>[];
  };

  expect(raw.checkRuns).toHaveLength(0);
  expect(raw.statuses).toHaveLength(0);
});

it('bounds enrichment concurrency for 100 pull requests', async () => {
  let active = 0;
  let maximum = 0;
  const client = fakeClient({
    pullRequests: async () =>
      Array.from({ length: 100 }, (_, index) => ({
        ...pullRequest(),
        number: index + 1,
        head: { sha: `head-${index + 1}` },
      })),
    checkRuns: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return [];
    },
  });
  const source = createGitHubPullRequestSource({
    client,
    repository: 'owner/repo',
    maxResults: 100,
    maxConcurrency: 4,
  });

  expect(await source.poll(new AbortController().signal)).toHaveLength(100);
  expect(maximum).toBeLessThanOrEqual(4);
});

function pullRequest() {
  return {
    number: 7,
    title: 'PR',
    body: null,
    state: 'open' as const,
    updated_at: '2026-07-30T12:00:00.000Z',
    head: { sha: 'head-a' },
    base: { sha: 'base-a' },
    user: { login: 'octocat', type: 'User' },
  };
}

function fakeClient(overrides: {
  pullRequests?: GitHubPullRequestSourceClient['listPullRequests'];
  checkRuns?: GitHubPullRequestSourceClient['listCheckRunsForRef'];
  statuses?: GitHubPullRequestSourceClient['getCombinedStatusForRef'];
  changedFiles?: GitHubPullRequestSourceClient['listPullRequestFiles'];
}): GitHubPullRequestSourceClient {
  return {
    listPullRequests: overrides.pullRequests ?? (async () => [pullRequest()]),
    listCheckRunsForRef: overrides.checkRuns ?? (async () => []),
    getCombinedStatusForRef: overrides.statuses ?? (async () => []),
    listPullRequestFiles: overrides.changedFiles ?? (async () => []),
  };
}

function sourceRuntime(client: GitHubPullRequestSourceClient) {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  const lookup = createResourceLookup({ journal, projections: new InMemoryProjectionStore() });
  const resources = createResourceService(journal, lookup);
  const work = createWorkService(journal);
  const pullRequests = createPullRequestService(journal, work, resources);
  const poll = new PollService(
    journal,
    createGitHubPullRequestSource({
      client,
      repository: 'owner/repo',
      maxResults: 10,
    }),
  );
  return {
    journal,
    checkpoints,
    lookup,
    resources,
    work,
    clock,
    pullRequests,
    poll,
    translator: new InboundTranslator(journal, work, resources, {
      pullRequests,
      lookup,
    }),
  };
}

async function processInbound(
  translator: InboundTranslator,
  journal: InMemoryEventJournal,
  checkpoints: InMemoryCheckpointStore,
) {
  return new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
  ).runOnce(translator.processor);
}

// These tests prove check-evidence translation, not admission, so the WorkItem/Resource are
// pre-established: the translator resolves an existing identity on the first poll and never
// needs a workflow to route into.
async function admitPullRequest(
  runtime: ReturnType<typeof sourceRuntime>,
  seed: string,
  externalKey: string,
): Promise<void> {
  const context = {
    commandId: 'pre-admit',
    correlationId: 'pre-admit' as never,
    occurredAt: runtime.clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  };
  const workItem = workId(seed);
  const resource = resId(seed);
  await runtime.work.create({ workItemId: workItem, objective: 'PR' }, context);
  await runtime.resources.discover(
    {
      resourceId: resource,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'github', key: externalKey },
      capabilities: [
        BuiltInResourceCapability.Commentable,
        BuiltInResourceCapability.Reviewable,
        BuiltInResourceCapability.Revisioned,
      ],
    },
    context,
  );
  await runtime.resources.correlate(resource, workItem, ResourceCorrelationRole.Primary, context);
}

function pagesOf(
  ...pages: readonly { readonly data: unknown; readonly headers?: Record<string, string> }[]
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) yield page;
    },
  };
}

function notModifiedPages() {
  return {
    // eslint-disable-next-line require-yield -- intentionally throws before any yield to exercise the 304 path
    async *[Symbol.asyncIterator]() {
      throw Object.assign(new Error('not modified'), { status: 304 });
    },
  };
}

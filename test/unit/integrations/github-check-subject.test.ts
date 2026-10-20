import { expect, it } from 'vitest';
import type { GitHubPullRequestPayload } from '../../../src/integrations/github/contracts/payloads.js';
import { verifiedCheckSubject } from '../../../src/integrations/github/infrastructure/pr-check-subject.js';
import type {
  CheckEvidence,
  PullRequestEvidenceClient,
} from '../../../src/integrations/github/infrastructure/pr-evidence.js';

const pr = {
  number: 7,
  head: { sha: 'head' },
  base: { sha: 'base' },
  merge_commit_sha: 'stale-merge',
} as GitHubPullRequestPayload;

function evidence(): CheckEvidence {
  return {
    available: true,
    complete: true,
    statuses: [],
    checkRuns: [
      {
        id: 99,
        head_sha: 'head',
        check_suite: { id: 42 },
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-20T00:05:00.000Z',
      },
    ],
  };
}

function client(base = 'base'): PullRequestEvidenceClient {
  return {
    listPullRequestFiles: async () => [],
    listCheckRunsForRef: async () => [],
    getCombinedStatusForRef: async () => [],
    checkExecution: async () => ({
      sha: 'tested-merge',
      parents: [{ sha: base }, { sha: 'head' }],
    }),
    workflowRunsForSuite: async () => [
      {
        id: 1,
        check_suite_id: 42,
        head_sha: 'head',
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        pull_requests: [{ number: 7, head: { sha: 'head' }, base: { sha: 'base' } }],
      },
    ],
  };
}

it('qualifies ordinary Actions head-SHA checks from the execution subject even when the test merge is stale', async () => {
  expect(await verifiedCheckSubject(client(), 'owner', 'repo', pr, evidence())).toEqual({
    checkEvidence: {
      testedRevision: 'tested-merge',
      headRevision: 'head',
      baseRevision: 'base',
      startedAt: '2026-10-20T00:05:00.000Z',
    },
  });
});
it('rejects an old-base execution even when it starts after maintenance', async () => {
  expect(await verifiedCheckSubject(client('old-base'), 'owner', 'repo', pr, evidence())).toEqual(
    {},
  );
});
it.each([
  'missing',
  'wrong-head',
  'pending',
  'failing',
  'undated',
  'truncated',
  'status',
  'unavailable',
  'target-event',
  'wrong-suite',
  'ambiguous',
])('fails closed for %s provenance', async (kind) => {
  const value = client();
  const checks = evidence();
  if (kind === 'missing') delete value.workflowRunsForSuite;
  if (kind === 'unavailable')
    value.workflowRunsForSuite = async () => {
      throw new Error('offline');
    };
  const check = checks.checkRuns[0]!;
  const changed = {
    ...checks,
    complete: kind !== 'truncated',
    statuses: kind === 'status' ? [{ state: 'success' }] : [],
    checkRuns: [
      {
        ...check,
        head_sha: kind === 'wrong-head' ? 'other' : 'head',
        status: kind === 'pending' ? 'in_progress' : 'completed',
        conclusion: kind === 'failing' ? 'failure' : 'success',
        started_at: kind === 'undated' ? null : check.started_at!,
      },
    ],
  };
  if (['target-event', 'wrong-suite', 'ambiguous'].includes(kind)) {
    const [run] = await value.workflowRunsForSuite!('owner', 'repo', 42);
    value.workflowRunsForSuite = async () =>
      kind === 'ambiguous'
        ? [run!, { ...run!, id: 2 }]
        : [
            {
              ...run!,
              event: kind === 'target-event' ? 'pull_request_target' : 'pull_request',
              check_suite_id: kind === 'wrong-suite' ? 99 : 42,
              pull_requests: run!.pull_requests ?? [],
            },
          ];
  }
  expect(await verifiedCheckSubject(value, 'owner', 'repo', pr, changed)).toEqual({});
});

it.each(['neutral', 'skipped'])(
  'preserves normal Actions %s jobs alongside successful checks',
  async (conclusion) => {
    const checks = evidence();
    const result = await verifiedCheckSubject(client(), 'owner', 'repo', pr, {
      ...checks,
      checkRuns: [...checks.checkRuns, { ...checks.checkRuns[0]!, conclusion }],
    });
    expect(result.checkEvidence).toMatchObject({ headRevision: 'head', baseRevision: 'base' });
  },
);

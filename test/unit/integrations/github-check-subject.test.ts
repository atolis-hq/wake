import { expect, it } from 'vitest';
import type { GitHubPullRequestPayload } from '../../../src/integrations/github/contracts/payloads.js';
import { verifiedCheckSubject } from '../../../src/integrations/github/infrastructure/pr-check-subject.js';
import type { GitHubPullRequestSourceClient } from '../../../src/integrations/github/infrastructure/pr-source.js';

const pr = {
  head: { sha: 'head' },
  base: { sha: 'base' },
  merge_commit_sha: 'merge',
} as GitHubPullRequestPayload;

function client(base = 'base'): GitHubPullRequestSourceClient {
  return {
    listPullRequests: async () => [],
    listPullRequestFiles: async () => [],
    getCommit: async () => ({ sha: 'merge', parents: [{ sha: base }, { sha: 'head' }] }),
    listCheckRunsForRef: async (_owner, _repo, ref) => [
      {
        head_sha: ref,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-20T00:05:00.000Z',
      },
    ],
    getCombinedStatusForRef: async () => [],
  };
}

it('uses executions on the immutable commit with the exact selected base and head as parents', async () => {
  expect(await verifiedCheckSubject(client(), 'owner', 'repo', pr, 100)).toEqual({
    checkEvidence: {
      testedRevision: 'merge',
      headRevision: 'head',
      baseRevision: 'base',
      startedAt: '2026-10-20T00:05:00.000Z',
    },
  });
});
it('rejects an old-base execution even when it starts after maintenance', async () => {
  expect(await verifiedCheckSubject(client('old-base'), 'owner', 'repo', pr, 100)).toEqual({});
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
])('fails closed for %s provenance', async (kind) => {
  const value = client();
  if (kind === 'missing') delete value.getCommit;
  if (kind === 'unavailable')
    value.getCommit = async () => {
      throw new Error('offline');
    };
  if (kind === 'status') value.getCombinedStatusForRef = async () => [{ state: 'success' }];
  if (['wrong-head', 'pending', 'failing', 'undated'].includes(kind)) {
    value.listCheckRunsForRef = async () => [
      {
        head_sha: kind === 'wrong-head' ? 'head' : 'merge',
        status: kind === 'pending' ? 'in_progress' : 'completed',
        conclusion: kind === 'failing' ? 'failure' : 'success',
        started_at: kind === 'undated' ? null : '2026-10-20T00:05:00.000Z',
      },
    ];
  }
  expect(
    await verifiedCheckSubject(value, 'owner', 'repo', pr, kind === 'truncated' ? 1 : 100),
  ).toEqual({});
});

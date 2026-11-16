import { expect } from 'vitest';
import { GitHubEventType } from '../../src/integrations/github/contracts/events.js';
import { createGitHubPullRequestSource } from '../../src/integrations/github/index.js';
import { adapterId } from '../../src/integrations/index.js';

/** Use the production source, including its passing-only execution verification. */
export async function githubCheckObservation(
  checks: 'failing' | 'passing' | 'unknown',
  head: string,
  adapter = adapterId('fake'),
  commitStatus = false,
) {
  const source = createGitHubPullRequestSource({
    repository: 'test/repo',
    maxResults: 100,
    adapter,
    client: {
      async listPullRequests() {
        return [
          {
            number: 1,
            title: 'Repair checks',
            body: '',
            state: 'open',
            updated_at: '2026-11-16T00:00:00.000Z',
            head: { sha: head },
            base: { sha: 'base' },
          },
        ];
      },
      async listCheckRunsForRef(_owner, _repo, ref) {
        expect(ref).toBe(head);
        return checks === 'unknown' || commitStatus
          ? []
          : [
              {
                id: 1,
                name: 'integration',
                head_sha: head,
                check_suite: { id: 1 },
                status: 'completed',
                conclusion: checks === 'failing' ? 'failure' : 'success',
                started_at: '2026-11-16T00:00:00.000Z',
              },
            ];
      },
      async getCombinedStatusForRef(_owner, _repo, ref) {
        expect(ref).toBe(head);
        return commitStatus ? [{ context: 'legacy-ci', state: 'failure' }] : [];
      },
      async listPullRequestFiles() {
        return ['src/kernel/index.ts'];
      },
      async workflowRunsForSuite() {
        return [];
      },
      async checkExecution() {
        return undefined;
      },
    },
  });
  const [observed] = await source.poll(new AbortController().signal);
  if (observed?.eventType !== GitHubEventType.WorkObserved)
    throw new Error('Expected GitHub PR observation');
  expect(observed.payload.checks).toBe(checks);
  expect(observed.payload.checkEvidence).toBeUndefined();
  return observed;
}

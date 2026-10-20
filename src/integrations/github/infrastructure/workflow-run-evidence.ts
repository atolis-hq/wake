import type { Octokit } from '@octokit/rest';
import type { GitHubWorkflowRunPayload } from '../contracts/payloads.js';
import { fetchWithEtag, type createEtagCache } from './etag-cache.js';

/** Revalidate mutable run attempts; conditional requests reuse unchanged responses. */
export function workflowRunsForSuite(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  suiteId: number,
): Promise<readonly GitHubWorkflowRunPayload[]> {
  return fetchWithEtag({
    cache,
    key: `workflow-run-suite:${owner}/${repo}@${suiteId}`,
    request: async (headers) => {
      const response = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        check_suite_id: suiteId,
        event: 'pull_request',
        per_page: 100,
        ...(headers === undefined ? {} : { headers }),
      });
      return {
        data: response.data.total_count >= 100 ? [] : response.data.workflow_runs,
        ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }),
      };
    },
  });
}

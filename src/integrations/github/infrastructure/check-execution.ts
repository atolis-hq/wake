import type { Octokit } from '@octokit/rest';
import { GitHubCheckRunStatus } from '../contracts/vocabulary.js';
import { checkoutRevision } from './checkout-revision.js';

export interface TestedCommit {
  readonly sha: string;
  readonly parents: readonly { readonly sha: string }[];
}

/** Completed job logs and Git objects are immutable; failed reads are never cached. */
export function createCheckExecutionReader(octokit: Octokit) {
  const jobs = new Map<string, Awaited<ReturnType<typeof loadJobs>>>();
  const commits = new Map<string, TestedCommit>();
  const checkouts = new Map<string, string>();

  async function loadJobs(owner: string, repo: string, runId: number) {
    const result = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      per_page: 100,
    });
    return result.data.total_count >= 100 ? [] : result.data.jobs;
  }

  function completeJobs(entries: Awaited<ReturnType<typeof loadJobs>>): boolean {
    return (
      entries.length > 0 && entries.every((job) => job.status === GitHubCheckRunStatus.Completed)
    );
  }

  return async (
    owner: string,
    repo: string,
    runId: number,
    attempt: number,
    checkId: number,
  ): Promise<TestedCommit | undefined> => {
    const prefix = `${owner}/${repo}`;
    const key = `${prefix}:${runId}:${attempt}`;
    let entries = jobs.get(key);
    if (entries === undefined) {
      entries = await loadJobs(owner, repo, runId);
      if (completeJobs(entries)) remember(jobs, key, entries);
    }
    const matches = entries.filter((job) => job.check_run_url?.endsWith(`/check-runs/${checkId}`));
    if (matches.length !== 1) return undefined;
    const job = matches[0]!;
    if (
      job.run_id !== runId ||
      job.status !== GitHubCheckRunStatus.Completed ||
      job.conclusion !== 'success'
    )
      return undefined;
    const jobKey = `${prefix}:${job.id}`;
    let revision = checkouts.get(jobKey);
    if (revision === undefined) {
      const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
      });
      if (typeof response.data !== 'string') return undefined;
      revision = checkoutRevision(response.data);
      if (revision === undefined) return undefined;
      remember(checkouts, jobKey, revision);
    }
    const commitKey = `${prefix}:${revision}`;
    let commit = commits.get(commitKey);
    if (commit === undefined) {
      const result = await octokit.rest.git.getCommit({ owner, repo, commit_sha: revision });
      if (result.data.sha !== revision) return undefined;
      commit = { sha: result.data.sha, parents: result.data.parents.map(({ sha }) => ({ sha })) };
      remember(commits, commitKey, commit);
    }
    return commit;
  };
}

function remember<Value>(cache: Map<string, Value>, key: string, value: Value): void {
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

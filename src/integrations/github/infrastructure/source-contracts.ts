import type { ProviderPermission } from '../../../activities/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubConfig } from '../contracts/config.js';
import type { GitHubIssueCommentPayload, GitHubReviewPayload } from '../contracts/payloads.js';
import type { issueObservation } from './issue-source.js';
import type { GitHubPullRequestSourceClient } from './pr-source.js';

export interface GitHubSourceClient extends GitHubPullRequestSourceClient {
  listIssues(
    owner: string,
    repo: string,
    maxResults: number,
    since?: string,
  ): Promise<readonly Parameters<typeof issueObservation>[0]['issue'][]>;
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    pageSize: number,
    since?: string,
    maxResults?: number,
  ): Promise<readonly GitHubIssueCommentPayload[]>;
  listReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    pageSize: number,
    maxResults?: number,
  ): Promise<readonly GitHubReviewPayload[]>;
  listReviewComments?(
    owner: string,
    repo: string,
    pullNumber: number,
    pageSize: number,
    maxResults?: number,
  ): Promise<readonly GitHubIssueCommentPayload[]>;
  collaboratorPermission?(owner: string, repo: string, login: string): Promise<ProviderPermission>;
}

export interface RepositoryPollContext {
  readonly client: GitHubSourceClient;
  readonly config: GitHubConfig;
  readonly adapter: AdapterId | undefined;
  readonly owner: string;
  readonly repo: string;
  readonly repository: string;
}

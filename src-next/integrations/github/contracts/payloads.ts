import { PullRequestState } from '../../../activities/index.js';
export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: typeof PullRequestState.Open | typeof PullRequestState.Closed;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
}

export interface GitHubPullRequestPayload extends GitHubIssuePayload {
  readonly pull_request?: Record<string, unknown>;
  readonly head?: { readonly sha?: string };
  readonly base?: { readonly sha?: string };
  readonly merged_at?: string | null;
}

export interface GitHubCheckRunPayload {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

export interface GitHubCommitStatusPayload {
  readonly id?: number;
  readonly context?: string;
  readonly state?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface GitHubReviewPayload {
  readonly id: number;
  readonly state: string;
  readonly body: string | null;
  readonly commit_id: string;
  readonly submitted_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
}

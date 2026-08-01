import type { PullRequestState } from '../../../activities/index.js';

export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: typeof PullRequestState.Open | typeof PullRequestState.Closed;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly assignees?: readonly ({ readonly login?: string } | null)[] | null;
  readonly pull_request?: Record<string, unknown>;
}

export function gitHubLabelNames(payload: GitHubIssuePayload): readonly string[] {
  return (payload.labels ?? []).flatMap((label) => {
    const name = typeof label === 'string' ? label : label.name;
    return name === undefined ? [] : [name];
  });
}

export function gitHubAssigneeLogins(payload: GitHubIssuePayload): readonly string[] {
  return (payload.assignees ?? []).flatMap((assignee) =>
    assignee?.login === undefined ? [] : [assignee.login],
  );
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

export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: 'open' | 'closed';
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
}

export interface GitHubPullRequestPayload extends GitHubIssuePayload {
  readonly pull_request?: Record<string, unknown>;
  readonly head?: { readonly sha?: string };
}

export interface GitHubRepositoryConfig {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubConfig {
  readonly token: string;
  readonly repositories: readonly GitHubRepositoryConfig[];
  readonly maxResults?: number;
}

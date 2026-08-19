/** Native GitHub issue-list filters that preserve every item admitted by intake. */
export interface GitHubIssueQueryFilters {
  readonly assignee?: string | undefined;
  readonly labels?: string | undefined;
}

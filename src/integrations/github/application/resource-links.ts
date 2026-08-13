import type { ExternalResourceKey, ResourceLinkResolver } from '../../../resources/index.js';

const issueOrPullRequestLocator = /^(?<owner>[^/]+)\/(?<repo>[^#]+)#(?<number>[1-9]\d*)$/;

export const resolveGitHubResourceUrl: ResourceLinkResolver = (
  externalKey: ExternalResourceKey,
): string | null => {
  const match = issueOrPullRequestLocator.exec(externalKey.key);
  if (match?.groups === undefined) return null;
  const { owner, repo, number } = match.groups;
  return `https://github.com/${owner}/${repo}/issues/${number}`;
};

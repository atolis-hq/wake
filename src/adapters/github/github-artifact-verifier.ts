import type { ArtifactVerifier } from '../../core/contracts.js';
import { buildResourceUri } from '../../domain/resource-uri.js';

const githubPrUrlPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function createGitHubArtifactVerifier(deps: {
  client: { getPullRequest: (owner: string, repo: string, pullNumber: number) => Promise<{ head: { ref: string } }> };
}): ArtifactVerifier {
  return {
    async verify(artifact, context) {
      if (artifact.kind !== 'pr') {
        return null;
      }

      const match = githubPrUrlPattern.exec(artifact.url);
      if (match === null) {
        return null;
      }
      const [, owner, repo, numberStr] = match;
      if (owner === undefined || repo === undefined || numberStr === undefined) {
        return null;
      }

      // GitHub owner/repo names are case-insensitive, so the URL's rendered
      // casing (owner/repo, as linked by the agent) can legitimately differ
      // from the configured context.repo string.
      if (`${owner}/${repo}`.toLowerCase() !== context.repo.toLowerCase()) {
        return null;
      }

      try {
        const pr = await deps.client.getPullRequest(owner, repo, Number(numberStr));
        if (pr.head.ref !== context.branch) {
          return null;
        }
        // Built from context.repo, not the URL's owner/repo casing, so this
        // resourceUri exact-matches the one discoverPullRequests/pollWatchedPr
        // build from the same configured repo string.
        return { resourceUri: buildResourceUri('github', 'pr', `${context.repo}#${numberStr}`) };
      } catch {
        return null;
      }
    },
  };
}

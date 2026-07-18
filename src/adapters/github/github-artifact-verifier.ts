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

      if (`${owner}/${repo}` !== context.repo) {
        return null;
      }

      try {
        const pr = await deps.client.getPullRequest(owner, repo, Number(numberStr));
        if (pr.head.ref !== context.branch) {
          return null;
        }
        return { resourceUri: buildResourceUri('github', 'pr', `${owner}/${repo}#${numberStr}`) };
      } catch {
        return null;
      }
    },
  };
}

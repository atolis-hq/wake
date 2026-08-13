import type { ArtifactVerifier } from '../../core/contracts.js';

/**
 * Permanent test harness. `verifies` is the allowlist of URLs this fake
 * treats as legitimate, mapped to the resourceUri they resolve to — anything
 * not listed fails verification, exercising the "malformed claim" path.
 */
export function createFakeArtifactVerifier(options: {
  verifies: Array<{ url: string; resourceUri: string }>;
}): ArtifactVerifier {
  const byUrl = new Map(options.verifies.map((entry) => [entry.url, entry.resourceUri]));

  return {
    async verify(artifact) {
      const resourceUri = byUrl.get(artifact.url);
      return resourceUri === undefined ? null : { resourceUri };
    },
  };
}

import type { ExternalResourceKey } from '../../resources/index.js';
import type { ProviderInstance } from '../contracts/provider.js';

/** Compare typed provider facts with the recorded producing Run. */
export function matchesArtifactSource(
  externalKey: ExternalResourceKey,
  observed: {
    readonly repository: string;
    readonly branch: string;
    readonly revision?: string | undefined;
    readonly base?: string | undefined;
  },
  context: Parameters<ProviderInstance['verifyArtifact']>[2],
): boolean {
  if (observed.branch !== context.workspaceBranch) return false;
  if (
    context.repository !== undefined &&
    (context.repository.adapter !== externalKey.adapter ||
      context.repository.key.toLowerCase() !== observed.repository.toLowerCase())
  )
    return false;
  if (context.workspaceRevision !== undefined && context.workspaceRevision !== observed.revision)
    return false;
  return context.pullRequestBase === undefined || context.pullRequestBase === observed.base;
}

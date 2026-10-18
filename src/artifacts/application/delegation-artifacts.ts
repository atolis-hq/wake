import type { ArtifactRevisionReference } from '../contracts/context.js';
import type { ArtifactContextService } from './artifact-context-service.js';
import type { ArtifactService } from './artifact-service.js';

/** Binds delegation to Artifacts grants and accepted exact revisions; children never see the join. */
export function createDelegationArtifacts(input: {
  readonly artifacts: ArtifactService;
  readonly contexts: ArtifactContextService;
  readonly accepted: (activationId: string, workItemId?: string) => Promise<boolean>;
}) {
  return {
    async validateInputs(
      _parent: { readonly workItemId: string },
      references: readonly ArtifactRevisionReference[],
    ) {
      const accepted = input.accepted;
      for (const reference of references) {
        const revision = (await input.artifacts.get(reference.workItemId))?.revisions.find(
          (candidate) => candidate.revisionId === reference.revisionId,
        );
        if (
          revision === undefined ||
          revision.deleted ||
          !(await accepted(revision.activationId, reference.workItemId))
        )
          throw new Error('Delegation context must reference accepted artifact revisions');
      }
    },
    registerChild: async (
      ...args: [
        Parameters<ArtifactContextService['registerChild']>[0],
        Parameters<ArtifactContextService['registerChild']>[2],
      ]
    ) => input.contexts.registerChild(args[0], input.accepted, args[1]),
    async qualifyingOutputs(
      child: { readonly workItemId: ArtifactRevisionReference['workItemId'] },
      outputs: readonly (
        | { readonly name: string; readonly path: string }
        | { readonly name: string; readonly kind: string }
      )[],
    ) {
      const published = await input.artifacts.latestPublished(child.workItemId, (activationId) =>
        input.accepted(activationId, child.workItemId),
      );
      if (outputs.some((output) => !('path' in output))) return null;
      const selected = outputs
        .filter((output) => 'path' in output)
        .map((output) => ({
          name: output.name,
          revision: published.find((revision) => revision.path === output.path),
        }));
      const references = [];
      for (const entry of selected) {
        if (entry.revision === undefined) return null;
        references.push({
          name: entry.name,
          reference: { workItemId: child.workItemId, revisionId: entry.revision.revisionId },
        });
      }
      return references;
    },
  };
}

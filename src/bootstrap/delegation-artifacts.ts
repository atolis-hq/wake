import type { ArtifactContextService, ArtifactService } from '../artifacts/index.js';
import type { DelegationArtifacts, OrchestrationService } from '../orchestration/index.js';

/** Binds delegation to Artifacts grants and accepted exact revisions; children never see the join. */
export function createDelegationArtifacts(input: {
  readonly artifacts: ArtifactService;
  readonly contexts: ArtifactContextService;
  readonly orchestration: OrchestrationService;
}): DelegationArtifacts {
  const accepted = async (activationId: string, workItemId?: string) =>
    (await input.orchestration.listAll()).some(
      (workflow) =>
        (workItemId === undefined || workflow.workItemId === workItemId) &&
        workflow.acceptedOutcomes.some((outcome) => outcome === activationId),
    );
  return {
    async validateInputs(_parent, references) {
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
    registerChild: (grant, context) => input.contexts.registerChild(grant, accepted, context),
    async qualifyingOutputs(child, outputs) {
      const published = await input.artifacts.latestPublished(child.workItemId, accepted);
      const selected = outputs.map((output) => ({
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

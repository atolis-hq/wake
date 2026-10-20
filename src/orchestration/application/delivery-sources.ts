import { RepositorySourceError, RepositorySourceFailure } from '../../execution/index.js';
import type { DelegationRepositories } from '../contracts/delegation-ports.js';
import { DeliveryRejectionError, type DeliveryCandidate } from '../contracts/delivery.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { CandidateSourceKind, DeliveryRejection } from '../contracts/vocabulary.js';
import { currentSelection, isChange, type DeliveryFacts } from '../domain/delivery-facts.js';

/**
 * Proves every candidate commit is fetchable from its authorized repository at the recorded
 * revision. A retained ref is resolved by name, so a moved or deleted ref fails; a selected
 * output is fetched by its exact commit. A local SHA alone is never a durable source.
 */
export async function verifyCandidateSources(
  parent: WorkflowInstanceView,
  repositories: DelegationRepositories | undefined,
  candidate: DeliveryCandidate,
  facts: DeliveryFacts,
): Promise<void> {
  for (const entry of candidate.repositories) {
    const source =
      entry.source.kind === CandidateSourceKind.RetainedRef
        ? { sourceRef: entry.source.ref }
        : { sourceRef: branchOf(facts, entry.contributions[0]), sourceRevision: entry.revision };
    const unavailable = (detail: string) =>
      new DeliveryRejectionError(
        DeliveryRejection.SourceUnavailable,
        `Candidate source ${source.sourceRef} in ${entry.resourceId} is unavailable: ${detail}`,
      );
    if (repositories === undefined) throw unavailable('source verification is not configured');
    let resolved;
    try {
      resolved = await repositories.resolve(parent, {
        resourceId: entry.resourceId,
        pullRequestBase: entry.pullRequestBase,
        ...source,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown source verification failure';
      if (
        error instanceof RepositorySourceError &&
        error.kind === RepositorySourceFailure.RefUnavailable
      )
        throw unavailable(detail);
      throw unavailable('operational fetch/check failed; candidate not verified: ' + detail);
    }
    if (resolved.sourceRevision.toLowerCase() !== entry.revision.toLowerCase())
      throw unavailable(`it now points at ${resolved.sourceRevision}, not ${entry.revision}`);
  }
}

function branchOf(
  facts: DeliveryFacts,
  contribution: DeliveryCandidate['repositories'][number]['contributions'][number] | undefined,
): string {
  const output = currentSelection(facts)?.entries.find(
    (entry) =>
      entry.childWorkItemId === contribution?.childWorkItemId &&
      entry.output.name === contribution.outputName,
  )?.output;
  return output !== undefined && isChange(output) ? output.reference.branch : 'HEAD';
}

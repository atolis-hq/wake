import type { DelegatedAssignment } from '../contracts/delegation.js';
import { DelegationConflictError } from '../contracts/delegation.js';
import { DelegationConflictCode } from '../contracts/vocabulary.js';
import { isChange, type Child, type DeliveryFacts } from './delivery-facts.js';

const invalid = (message: string) =>
  new DelegationConflictError(DelegationConflictCode.ReplacementInvalid, message);

/** The original must be a required assignment of this delivery, never another replacement. */
export function originalOf(
  facts: DeliveryFacts,
  replaces: NonNullable<DelegatedAssignment['replaces']>,
): Child {
  const original = facts.reservations
    .filter((reservation) => reservation.cohortId === replaces.cohortId)
    .flatMap((reservation) => reservation.children)
    .find((child) => child.assignmentId === replaces.assignmentId && child.replaces === undefined);
  if (original === undefined)
    throw invalid('A replacement must name an original required assignment of this delivery');
  return original;
}

/**
 * A corrective child keeps the original acceptance criteria, repository and outputs. When the
 * original contribution is unmerged it must be the starting point, aimed at the intended base.
 */
export function assertCriteriaPreserving(
  facts: DeliveryFacts,
  original: Child,
  assignment: DelegatedAssignment,
): void {
  if (!original.criteria.every((criterion) => assignment.criteria.includes(criterion)))
    throw invalid('A replacement must preserve every original acceptance criterion');
  if (original.repository?.resourceId !== assignment.repository?.resourceId)
    throw invalid('A replacement must target the original repository');
  assertOutputsProvided(original, assignment);
  const unmerged = facts.results
    .filter((entry) => entry.childWorkItemId === original.workItemId)
    .flatMap((entry) => entry.outputs.filter(isChange))
    .filter((output) => output.reference.merged !== true);
  for (const output of unmerged) {
    const counterpart = assignment.outputs.find((entry) => entry.name === output.name);
    const repository =
      counterpart !== undefined && 'kind' in counterpart
        ? (counterpart.repository ?? assignment.repository)
        : assignment.repository;
    assertCarriesContribution(repository, output.reference);
  }
}

function assertOutputsProvided(original: Child, assignment: DelegatedAssignment): void {
  for (const output of original.outputs) {
    const counterpart = assignment.outputs.find((entry) => entry.name === output.name);
    if (counterpart === undefined || 'kind' in output !== 'kind' in counterpart)
      throw invalid(`A replacement must provide the original output ${output.name}`);
    if (output.required !== false && counterpart.required === false)
      throw invalid('A replacement must preserve the original required output ' + output.name);
    if ('kind' in output && 'kind' in counterpart) assertChangeRequirements(output, counterpart);
  }
}

function assertCarriesContribution(
  repository: DelegatedAssignment['repository'],
  reference: { branch: string; revision: string; pullRequestBase: string },
): void {
  if (repository?.sourceRevision !== reference.revision)
    throw invalid(
      `A replacement must start from the unmerged contribution ${reference.branch}@${reference.revision}`,
    );
  if (repository.pullRequestBase !== reference.pullRequestBase)
    throw invalid(
      `A replacement must target the intended integration branch ${reference.pullRequestBase}`,
    );
}

function assertChangeRequirements(
  original: {
    readonly requireReview?: boolean | undefined;
    readonly requireChecks?: boolean | undefined;
  },
  replacement: {
    readonly requireReview?: boolean | undefined;
    readonly requireChecks?: boolean | undefined;
  },
): void {
  if ((original.requireReview ?? true) && !(replacement.requireReview ?? true))
    throw invalid('A replacement must preserve the original review requirement');
  if ((original.requireChecks ?? true) && !(replacement.requireChecks ?? true))
    throw invalid('A replacement must preserve the original checks requirement');
}

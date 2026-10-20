import { PullRequestMergeability, PullRequestState } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { DeliveryOutputKey } from '../contracts/delivery.js';
import { BaseMovement, IntegrationState, MaintenanceReason } from '../contracts/vocabulary.js';
import {
  currentSelection,
  isChange,
  outputKey,
  type ChangeReference,
  type DeliveryFacts,
} from './delivery-facts.js';

/** The provider facts the integration decision needs; never inferred from agent claims. */
export interface PullRequestObservation {
  readonly state: PullRequestState;
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly mergeability?: PullRequestMergeability | undefined;
}

export interface IntegrationTarget {
  readonly output: DeliveryOutputKey;
  /** The pull request's primary owner: it never changes and is never the requesting parent. */
  readonly ownerWorkItemId: WorkItemId;
  readonly resourceId: string;
  readonly repositoryResourceId: string;
  readonly branch: string;
  readonly pullRequestBase: string;
  /** The selected subject's head; a merged change is only verified at exactly this head. */
  readonly revision: string;
  /** 0 targets the integration branch; each stacked layer sits one above the change it targets. */
  readonly layer: number;
  readonly state: IntegrationState;
  readonly maintenance?: MaintenanceReason;
  readonly baseMovement: BaseMovement;
  /** Only the targets that need fresh review, checks and QA; unrelated subjects keep theirs. */
  readonly evidenceAffected: boolean;
  /** A merged change whose merged head is not the subject that was reviewed and tested. */
  readonly unverifiedMerge: boolean;
  readonly detail?: string;
}

/** What completion needs to know about integration. */
export interface IntegrationOutcome {
  readonly complete: boolean;
  readonly summary: string;
}

export interface IntegrationAssessment extends IntegrationOutcome {
  readonly targets: readonly IntegrationTarget[];
  /** The next planned merge: the first unmerged change, and only when it is ready. */
  readonly next: IntegrationTarget | null;
  /** The first unmerged change when it cannot proceed yet. */
  readonly blocking: IntegrationTarget | null;
}

/** Providers report an unobserved revision with the shared unknown placeholder, not by omitting it. */
const unobservedRevision: string = PullRequestMergeability.Unknown;

export const known = (value: string | undefined): value is string =>
  value !== undefined && value !== '' && value !== unobservedRevision;

interface Change {
  readonly output: DeliveryOutputKey;
  readonly reference: ChangeReference;
}

/**
 * Derives integration progress from the selected subjects and actual provider state. Partial
 * progress is whatever the provider shows merged; there is no separate progress record, so a
 * restart recomputes the same answer, and ordinary merges never count as defect corrections.
 */
export function assessIntegration(
  facts: DeliveryFacts,
  observations: ReadonlyMap<string, PullRequestObservation>,
  held: ReadonlyMap<string, string>,
): IntegrationAssessment {
  const changes: Change[] = (currentSelection(facts)?.entries ?? []).flatMap((entry) =>
    isChange(entry.output)
      ? [
          {
            output: { childWorkItemId: entry.childWorkItemId, outputName: entry.output.name },
            reference: entry.output.reference,
          },
        ]
      : [],
  );
  const observed = (change: Change) => observations.get(change.reference.resourceId);
  const merged = (change: Change) => observed(change)?.state === PullRequestState.Merged;
  const lowerOf = (change: Change) =>
    changes.find(
      (candidate) =>
        candidate !== change &&
        candidate.reference.repositoryResourceId === change.reference.repositoryResourceId &&
        candidate.reference.branch === change.reference.pullRequestBase,
    );
  const layerOf = (change: Change, depth = 0): number => {
    const lower = lowerOf(change);
    return lower === undefined || depth > changes.length ? 0 : layerOf(lower, depth + 1) + 1;
  };
  const targets = changes
    .map((change): IntegrationTarget => {
      const lower = lowerOf(change);
      const plannedBase = changes.some(
        (other) =>
          other !== change &&
          other.reference.repositoryResourceId === change.reference.repositoryResourceId &&
          other.reference.pullRequestBase === change.reference.pullRequestBase &&
          merged(other) &&
          known(observed(change)?.baseRevision) &&
          sameRevision(observed(change)!.baseRevision, other.reference.revision),
      );
      return decide(change, {
        observation: observed(change),
        held: held.get(change.output.childWorkItemId),
        lower: lower === undefined ? undefined : { merged: merged(lower), change: lower },
        plannedBase,
        layer: layerOf(change),
      });
    })
    .sort(
      (a, b) =>
        a.repositoryResourceId.localeCompare(b.repositoryResourceId) ||
        a.layer - b.layer ||
        outputKey(a.output).localeCompare(outputKey(b.output)),
    );
  const unmerged = targets.filter((target) => target.state !== IntegrationState.Merged);
  const first = unmerged[0] ?? null;
  const next = first?.state === IntegrationState.Ready ? first : null;
  const complete =
    changes.length > 0 && unmerged.length === 0 && targets.every((t) => !t.unverifiedMerge);
  return {
    targets,
    next,
    blocking: first !== null && next === null ? first : null,
    complete,
    summary: summarize(targets, next, first, complete),
  };
}

function decide(
  change: Change,
  input: {
    readonly observation: PullRequestObservation | undefined;
    readonly held: string | undefined;
    readonly lower: { readonly merged: boolean; readonly change: Change } | undefined;
    readonly plannedBase: boolean;
    readonly layer: number;
  },
): IntegrationTarget {
  const { reference } = change;
  const base = {
    output: change.output,
    ownerWorkItemId: reference.workItemId,
    resourceId: reference.resourceId,
    repositoryResourceId: reference.repositoryResourceId,
    branch: reference.branch,
    pullRequestBase: reference.pullRequestBase,
    revision: reference.revision,
    layer: input.layer,
    baseMovement: BaseMovement.None as BaseMovement,
    evidenceAffected: false,
    unverifiedMerge: false,
  };
  const { observation } = input;
  if (observation?.state === PullRequestState.Merged)
    return {
      ...base,
      state: IntegrationState.Merged,
      unverifiedMerge: !sameRevision(observation.headRevision, reference.revision),
    };
  if (input.held !== undefined)
    return { ...base, state: IntegrationState.Held, detail: input.held };
  if (observation === undefined) return { ...base, state: IntegrationState.Unobserved };
  if (observation.state === PullRequestState.Closed)
    return { ...base, state: IntegrationState.Closed };
  const movement = baseMovement(reference, observation, input.plannedBase);
  const maintain = (reason: MaintenanceReason, detail: string): IntegrationTarget => ({
    ...base,
    baseMovement: movement,
    state: IntegrationState.MaintenanceRequired,
    maintenance: reason,
    evidenceAffected: true,
    detail,
  });
  // Another writer changed the branch: the reviewed and tested subject no longer exists.
  if (!sameRevision(observation.headRevision, reference.revision))
    return maintain(
      MaintenanceReason.HeadMoved,
      `the provider head ${observation.headRevision} is not the recorded subject ${reference.revision}`,
    );
  if (input.lower !== undefined) {
    if (!input.lower.merged)
      return {
        ...base,
        baseMovement: movement,
        state: IntegrationState.AwaitingLowerLayer,
        detail: `waiting for ${input.lower.change.output.childWorkItemId}`,
      };
    return maintain(
      MaintenanceReason.Retarget,
      `${input.lower.change.reference.branch} merged; retarget ${reference.branch} to the integration branch`,
    );
  }
  if (observation.mergeability === PullRequestMergeability.Conflicting)
    return maintain(MaintenanceReason.Conflict, 'the provider reports conflicts with the base');
  if (movement === BaseMovement.Unrelated)
    return maintain(
      MaintenanceReason.BaseMoved,
      'the base moved outside this delivery, so the tested combination is unproven',
    );
  return { ...base, baseMovement: movement, state: IntegrationState.Ready };
}

/** Credit only an exact selected merged head; squash or unexplained movement needs fresh evidence. */
function baseMovement(
  reference: ChangeReference,
  observation: PullRequestObservation,
  plannedBase: boolean,
): BaseMovement {
  if (!known(reference.baseRevision) || !known(observation.baseRevision)) return BaseMovement.None;
  if (sameRevision(reference.baseRevision, observation.baseRevision)) return BaseMovement.None;
  return plannedBase ? BaseMovement.PlannedProgress : BaseMovement.Unrelated;
}

export const sameRevision = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function summarize(
  targets: readonly IntegrationTarget[],
  next: IntegrationTarget | null,
  first: IntegrationTarget | null,
  complete: boolean,
): string {
  if (targets.length === 0) return 'no selected changes to integrate';
  const mergedCount = targets.filter((target) => target.state === IntegrationState.Merged).length;
  const progress = `${mergedCount}/${targets.length} selected changes merged`;
  if (complete) return progress;
  if (targets.some((target) => target.unverifiedMerge))
    return `${progress}; a merged head differs from the reviewed and tested subject`;
  if (next !== null) return `${progress}; next is ${outputKey(next.output)}`;
  if (first === null) return progress;
  return `${progress}; ${outputKey(first.output)} is ${first.state}${
    first.maintenance === undefined ? '' : ` (${first.maintenance})`
  }`;
}

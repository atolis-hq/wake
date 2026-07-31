import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityResourceRole,
  IntentAppendStatus,
} from '../contracts/vocabulary.js';
import { PullRequestDenialCode } from './vocabulary.js';
import { z } from 'zod';

import { type EventJournal } from '../../kernel/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  type ResourceCapability,
  type ResourceId,
  type ResourceView,
  type ResourceStreamRef,
} from '../../resources/index.js';
import type { WorkItemStreamRef } from '../../work/index.js';
import type { WorkItemId } from '../../work/index.js';
import type {
  PullRequestActivityOutcome,
  PullRequestAuthorityInput,
  PullRequestTarget,
} from './contracts.js';
import type { IntentAppender, IntentAppendResult } from './intent.js';
import type { ActivityFactDraft } from '../contracts/events.js';

export const pullRequestTargetSchema = z
  .union([
    z.literal(ActivityResourceRole.Primary),
    z.object({ resourceId: z.string().min(1).transform(resourceId) }).strict(),
  ])
  .default(ActivityResourceRole.Primary);

export const pullRequestOutcomeSchema: z.ZodType<PullRequestActivityOutcome> = z.union([
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Waiting),
      data: z
        .object({ intentEventId: z.string(), signalKind: z.literal('delivery-result') })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Done),
      data: z.object({ deliveryEventId: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Blocked),
      data: z
        .object({
          reason: z.enum([
            PullRequestDenialCode.MissingResource,
            PullRequestDenialCode.AmbiguousResource,
            PullRequestDenialCode.CorrelationConflict,
            PullRequestDenialCode.Closed,
            PullRequestDenialCode.StaleApproval,
            PullRequestDenialCode.ChecksPending,
            PullRequestDenialCode.ChecksFailing,
            PullRequestDenialCode.UntrustedActor,
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ActivityOutcomeKind.Failed),
      data: z
        .object({
          reason: z.literal(ActivityFailureCode.IntentWriteFailed),
        })
        .strict(),
    })
    .strict(),
]);

interface CandidateAudit {
  readonly resourceId: ResourceId;
  readonly revision: string | null;
}

type CapabilityResolution =
  | { readonly allowed: true; readonly resourceId: ResourceId }
  | {
      readonly allowed: false;
      readonly reason:
        | typeof PullRequestDenialCode.MissingResource
        | typeof PullRequestDenialCode.AmbiguousResource;
      readonly candidates: readonly CandidateAudit[];
    };

export function resolvePrimaryCapability(
  invocationResources: readonly ResourceView[],
  authority: PullRequestAuthorityInput,
  workItemId: WorkItemId,
  target: PullRequestTarget,
  capability: ResourceCapability,
): CapabilityResolution {
  const primaryCandidates = authority.resources.filter(
    (entry) =>
      entry.resource.kind === BuiltInResourceKind.PullRequest &&
      entry.correlations.some(
        (correlation) =>
          correlation.role === ResourceCorrelationRole.Primary &&
          correlation.workItemId === workItemId,
      ),
  );
  const targetedCandidates = primaryCandidates.filter(
    (entry) =>
      target === ActivityResourceRole.Primary || entry.resource.resourceId === target.resourceId,
  );
  const capableIds = new Set(
    invocationResources
      .filter(
        (resource) =>
          resource.kind === BuiltInResourceKind.PullRequest &&
          resource.capabilities.includes(capability),
      )
      .map((resource) => resource.resourceId),
  );
  const matches = targetedCandidates.filter((entry) => capableIds.has(entry.resource.resourceId));
  if (matches.length === 1) return { allowed: true, resourceId: matches[0]!.resource.resourceId };
  return {
    allowed: false,
    reason:
      matches.length === 0
        ? PullRequestDenialCode.MissingResource
        : PullRequestDenialCode.AmbiguousResource,
    candidates: candidateAudit(
      authority,
      primaryCandidates.map((entry) => entry.resource.resourceId),
    ),
  };
}

export function selectionDenialAudit(
  target: PullRequestTarget,
  candidates: readonly CandidateAudit[],
) {
  return {
    target,
    candidates,
    resourceId: null,
    revision: null,
  };
}

export function selectedDenialAudit(authority: PullRequestAuthorityInput, selected: ResourceId) {
  const view = authority.pullRequests.find((candidate) => candidate.resourceId === selected);
  return {
    resourceId: selected,
    revision: view?.headRevision ?? null,
  };
}

export async function appendResolved(
  journal: EventJournal,
  appender: IntentAppender,
  stream: ResourceStreamRef | WorkItemStreamRef,
  event: ActivityFactDraft,
): Promise<Exclude<IntentAppendResult, typeof IntentAppendStatus.Ambiguous>> {
  const result = await appender.append(stream, event);
  if (result !== IntentAppendStatus.Ambiguous) return result;
  const events = await journal.readStream(stream);
  return events.some((candidate) => candidate.eventId === event.eventId)
    ? IntentAppendStatus.Known
    : IntentAppendStatus.Failed;
}

function candidateAudit(
  authority: PullRequestAuthorityInput,
  resourceIds: readonly ResourceId[],
): readonly CandidateAudit[] {
  return [...resourceIds]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({
      resourceId: id,
      revision:
        authority.pullRequests.find((candidate) => candidate.resourceId === id)?.headRevision ??
        null,
    }));
}

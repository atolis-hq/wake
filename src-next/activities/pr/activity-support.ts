import { z } from 'zod';

import { type EventJournal } from '../../kernel/index.js';
import {
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
    z.literal('primary'),
    z.object({ resourceId: z.string().min(1).transform(resourceId) }).strict(),
  ])
  .default('primary');

export const pullRequestOutcomeSchema: z.ZodType<PullRequestActivityOutcome> = z.union([
  z
    .object({
      kind: z.literal('waiting'),
      data: z
        .object({ intentEventId: z.string(), signalKind: z.literal('delivery-result') })
        .strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal('done'), data: z.object({ deliveryEventId: z.string() }).strict() })
    .strict(),
  z
    .object({ kind: z.literal('blocked'), data: z.object({ reason: z.string() }).strict() })
    .strict(),
  z.object({ kind: z.literal('failed'), data: z.object({ reason: z.string() }).strict() }).strict(),
]);

interface CandidateAudit {
  readonly resourceId: ResourceId;
  readonly revision: string | null;
}

export type CapabilityResolution =
  | { readonly allowed: true; readonly resourceId: ResourceId }
  | {
      readonly allowed: false;
      readonly reason: 'missing-resource' | 'ambiguous-resource';
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
      entry.resource.kind === 'pull-request' &&
      entry.correlations.some(
        (correlation) => correlation.role === 'primary' && correlation.workItemId === workItemId,
      ),
  );
  const targetedCandidates = primaryCandidates.filter(
    (entry) => target === 'primary' || entry.resource.resourceId === target.resourceId,
  );
  const capableIds = new Set(
    invocationResources
      .filter(
        (resource) =>
          resource.kind === 'pull-request' && resource.capabilities.includes(capability),
      )
      .map((resource) => resource.resourceId),
  );
  const matches = targetedCandidates.filter((entry) => capableIds.has(entry.resource.resourceId));
  if (matches.length === 1) return { allowed: true, resourceId: matches[0]!.resource.resourceId };
  return {
    allowed: false,
    reason: matches.length === 0 ? 'missing-resource' : 'ambiguous-resource',
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
): Promise<Exclude<IntentAppendResult, 'ambiguous'>> {
  const result = await appender.append(stream, event);
  if (result !== 'ambiguous') return result;
  const events = await journal.readStream(stream);
  return events.some((candidate) => candidate.eventId === event.eventId) ? 'known' : 'failed';
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

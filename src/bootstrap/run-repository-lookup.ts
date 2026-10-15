import { scanJournal, yieldScan, type EventJournal } from '@atolis-hq/eventing';
import type { RunRepositoryLookup } from '../execution/index.js';
import {
  OrchestrationEventType,
  selectWorkflowOrchestrationEvent,
} from '../orchestration/index.js';
import {
  BuiltInResourceKind,
  repositoryCandidate,
  resourceCorrelationProjection,
  resourceProjection,
  selectResourceEvent,
  type ResourceCorrelationView,
  type ResourceRepositoryIdentityResolver,
  type ResourceView,
} from '../resources/index.js';
import type { WorkItemId } from '../work/index.js';

export function createRunRepositoryLookup(
  journal: EventJournal,
  resolveIdentity?: ResourceRepositoryIdentityResolver,
): RunRepositoryLookup {
  return async (query) => {
    const workByWorkflow = new Map<string, WorkItemId>();
    const resources = new Map<string, ResourceView | null>();
    const correlations = new Map<string, readonly ResourceCorrelationView[]>();
    for await (const event of scanJournal(journal, query.signal)) {
      const workflow = selectWorkflowOrchestrationEvent(event);
      if (workflow?.event.eventType === OrchestrationEventType.InstanceStarted)
        workByWorkflow.set(workflow.stream.id, workflow.event.payload.workItemId);
      const resource = selectResourceEvent(event);
      if (resource === null) continue;
      const id = resource.stream.id;
      resources.set(id, resourceProjection.project(resources.get(id) ?? null, event));
      correlations.set(
        id,
        resourceCorrelationProjection.project(correlations.get(id) ?? [], event),
      );
    }
    const byWork = await groupCandidates(resources, correlations, query.signal);
    let processed = 0;
    const identities = new Map<WorkItemId, string | undefined>();
    for (const [work, candidates] of byWork) {
      if (processed++ % 100 === 0) await yieldScan(query.signal);
      identities.set(work, candidateIdentity(candidates, resolveIdentity));
    }
    return (run) => {
      const work = workByWorkflow.get(run.workflowInstanceId);
      return work === undefined ? undefined : identities.get(work);
    };
  };
}

async function groupCandidates(
  resources: ReadonlyMap<string, ResourceView | null>,
  correlations: ReadonlyMap<string, readonly ResourceCorrelationView[]>,
  signal?: AbortSignal,
) {
  const byWork = new Map<WorkItemId, ResourceView[]>();
  let processed = 0;
  for (const [id, links] of correlations) {
    if (processed++ % 100 === 0) await yieldScan(signal);
    signal?.throwIfAborted();
    const resource = resources.get(id);
    if (resource == null) continue;
    for (const link of links) {
      const candidates = byWork.get(link.workItemId) ?? [];
      candidates.push(resource);
      byWork.set(link.workItemId, candidates);
    }
  }

  return byWork;
}

function candidateIdentity(
  candidates: readonly ResourceView[],
  resolveIdentity?: ResourceRepositoryIdentityResolver,
): string | undefined {
  const resource = repositoryCandidate(candidates);
  if (resource === undefined) return undefined;
  if (resource.kind === BuiltInResourceKind.Repository)
    return resource.externalKey.key || undefined;
  return resolveIdentity?.(resource.externalKey);
}

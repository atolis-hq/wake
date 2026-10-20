import { DelegationOutputKind, WorkflowArtifactOutputKind } from '../orchestration/index.js';
import { presentResource, toWorkItemKey, type WorkDetailResponse } from '../surfaces/index.js';
import type { WorkItemView } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

export async function presentDelivery(
  root: CompositionRoot,
  work: WorkItemView,
): Promise<Pick<WorkDetailResponse, 'delegation'>> {
  if ((root as Partial<CompositionRoot>).orchestration?.deliveryTree === undefined) return {};
  const cohorts = await root.orchestration.deliveryTree(work.workItemId);
  if (cohorts.length === 0 && work.delegation === undefined) return {};
  const delivery = await root.work.deliverySnapshot();
  const state = await deliveryStateFor(root, work);
  const qa = state === undefined ? undefined : presentQa(state);
  const selected = new Set(
    state?.selection?.entries.map((entry) => `${entry.childWorkItemId}/${entry.output.name}`),
  );
  const stale = staleOutputs(state, cohorts);
  const staleKeys = new Set(stale.map((entry) => `${entry.workItemKey}/${entry.outputName}`));
  return {
    delegation: {
      ...(qa === undefined ? {} : { qa: { ...qa, staleOutputs: stale } }),
      cohorts: cohorts.map((cohort) => ({
        cohortId: cohort.cohortId,
        settled: cohort.settled,
        ...(cohort.failureReason === undefined ? {} : { failureReason: cohort.failureReason }),
      })),
      rootWorkItemKey: toWorkItemKey(work.delegation?.rootWorkItemId ?? work.workItemId),
      ...(work.delegation === undefined
        ? {}
        : { parentWorkItemKey: toWorkItemKey(work.delegation.parentWorkItemId) }),
      children: await Promise.all(
        cohorts.flatMap((cohort) =>
          cohort.children.map(async (child) => {
            const availability = delivery.availability(child.workItemId);
            const resources = await Promise.all(
              (await root.resources.correlationsForWork(child.workItemId)).map((entry) =>
                root.resources.get(entry.resourceId),
              ),
            );
            return {
              workItemKey: toWorkItemKey(child.workItemId),
              parentWorkItemKey: toWorkItemKey(cohort.parentWorkItemId),
              objective: child.objective,
              workflowName: child.workflowName,
              status: child.workflow?.status ?? 'registration-pending',
              cohortId: cohort.cohortId,
              ...presentPlacement(child, selected, staleKeys),
              ...((availability.reason ?? child.prerequisiteBlocker ?? child.workflow?.blockReason)
                ? {
                    blockReason: (availability.reason ??
                      child.prerequisiteBlocker ??
                      child.workflow?.blockReason)!,
                  }
                : {}),
              resources: resources
                .filter((entry) => entry !== null)
                .map(presentResource(root.resolveResourceLink)),
            };
          }),
        ),
      ),
    },
  };
}

type Cohorts = Awaited<ReturnType<CompositionRoot['orchestration']['deliveryTree']>>;

/** Stale keys are `cohort/assignment/output`; the reason is the one the selection rules apply. */
function staleOutputs(state: DeliveryStateView | undefined, cohorts: Cohorts) {
  const owners = new Map(
    cohorts.flatMap((cohort) =>
      cohort.children.map((child) => [`${cohort.cohortId}/${child.assignmentId}`, child] as const),
    ),
  );
  return (state?.stale ?? []).flatMap((key) => {
    const [cohortId, assignmentId, ...name] = key.split('/');
    const owner = owners.get(`${cohortId}/${assignmentId}`);
    return owner === undefined
      ? []
      : [
          {
            workItemKey: toWorkItemKey(owner.workItemId),
            outputName: name.join('/'),
            reason:
              'Built on an output that has since been replaced; it must be refreshed or reselected',
          },
        ];
  });
}

function presentPlacement(
  child: Cohorts[number]['children'][number],
  selected: ReadonlySet<string>,
  staleKeys: ReadonlySet<string>,
) {
  return {
    ...(child.workflow === null ? {} : { currentStage: child.workflow.currentStage }),
    ...(child.repository === undefined
      ? {}
      : {
          repository: {
            resourceId: child.repository.resourceId,
            pullRequestBase: child.repository.pullRequestBase,
          },
        }),
    prerequisites: (child.prerequisiteWorkItemIds ?? []).map(toWorkItemKey),
    ...(child.replaces === undefined ? {} : { replaces: child.replaces }),
    outputs: child.outputs.map((output) => ({
      name: output.name,
      kind: 'kind' in output ? DelegationOutputKind.Change : WorkflowArtifactOutputKind,
      required: output.required !== false,
      selected: selected.has(`${child.workItemId}/${output.name}`),
      stale: staleKeys.has(`${toWorkItemKey(child.workItemId)}/${output.name}`),
    })),
  };
}

async function deliveryStateFor(root: CompositionRoot, work: WorkItemView) {
  const parent = (await root.orchestration.listAll()).find(
    (view) => view.workItemId === work.workItemId && view.parentWorkflowInstanceId === undefined,
  );
  return parent === undefined
    ? undefined
    : await root.orchestration.deliveryStateFor(parent.workflowInstanceId);
}

type DeliveryStateView = NonNullable<Awaited<ReturnType<typeof deliveryStateFor>>>;

function presentQa(state: DeliveryStateView) {
  return {
    ...(state.integration === null
      ? {}
      : {
          integration: {
            complete: state.integration.complete,
            summary: state.integration.summary,
            targets: state.integration.targets.map((target) => ({
              workItemKey: toWorkItemKey(target.ownerWorkItemId),
              outputName: target.output.outputName,
              state: target.state,
              layer: target.layer,
              baseMovement: target.baseMovement,
              evidenceAffected: target.evidenceAffected,
              ...(target.maintenance === undefined ? {} : { maintenance: target.maintenance }),
              ...(target.detail === undefined ? {} : { detail: target.detail }),
            })),
            maintenance: state.maintenance.map((item) => ({
              maintenanceId: item.maintenanceId,
              workItemKey: toWorkItemKey(item.target.childWorkItemId),
              outputName: item.target.outputName,
              kind: item.kind,
              previousRevision: item.previous.revision,
              currentRevision: item.current.revision,
              producerRunId: item.producer.runId,
            })),
          },
        }),
    selectionRevision: state.selectionRevision,
    ...(state.candidate === null ? {} : { candidateId: state.candidate.candidateId }),
    repositories:
      state.candidate?.repositories.map((entry) => ({
        resourceId: entry.resourceId,
        revision: entry.revision,
      })) ?? [],
    stale: state.stale,
    ...(state.qa === null ? {} : { verdict: state.qa.verdict }),
    effective: state.qaEffective,
    canComplete: state.completion.complete,
    ...(state.completion.reason === undefined ? {} : { reason: state.completion.reason }),
    exhausted: state.repair.exhausted,
    findings: state.repair.unresolvedFindings,
  };
}

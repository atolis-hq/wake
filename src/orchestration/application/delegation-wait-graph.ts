import {
  ActivityResourceRole,
  BuiltInActivityName,
  pullRequestMergeInputSchema,
} from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import {
  DelegationConflictError,
  type DelegationPrerequisite,
  type DelegationReservation,
} from '../contracts/delegation.js';
import {
  DelegationConflictCode as Code,
  DelegationPrerequisiteCondition as Condition,
} from '../contracts/vocabulary.js';
import { type DelegationLedger, isSettled } from './delegation-ledger.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

type Child = DelegationReservation['children'][number];

/** Resolve local keys once under the root reservation's sequence guard. */
export async function resolvePrerequisites(
  candidate: DelegationReservation,
  existing: readonly DelegationReservation[],
  ledger: DelegationLedger,
  definitions: WorkflowDefinitionRegistry,
  mergeAvailable: (target: Child, output: string) => Promise<boolean>,
): Promise<DelegationReservation> {
  const all = [...existing, candidate];
  const resolved = {
    ...candidate,
    children: candidate.children.map((child) => resolveChild(candidate, child, all)),
  };
  const graph = new Map<string, string[]>();
  const add = (from: string, to: string) => graph.set(from, [...(graph.get(from) ?? []), to]);
  const events = await ledger.events();
  const reservations = [...existing, resolved];
  for (const reservation of reservations) {
    const unsettled = reservation === resolved || !isSettled(events, reservation);
    for (const child of reservation.children) {
      if (unsettled) add(reservation.parentWorkItemId, child.workItemId);
      for (const id of child.prerequisiteWorkItemIds ?? []) add(child.workItemId, id);
      const waits = await mergeWaits(child, reservations, definitions, mergeAvailable);
      for (const [from, to] of waits) if (unsettled) add(from, to);
    }
  }
  assertAcyclic(graph);
  return resolved;
}

function resolveChild(
  candidate: DelegationReservation,
  child: Child,
  all: readonly DelegationReservation[],
): Child {
  if (child.prerequisites === undefined) return child;
  if (child.prerequisites.filter((edge) => edge.useAsBase).length > 1)
    reject(Code.MultipleBases, 'Select at most one upstream Git base');
  return {
    ...child,
    prerequisiteWorkItemIds: child.prerequisites.map((edge) => {
      const cohort = all.find((entry) => entry.cohortId === (edge.cohortId ?? candidate.cohortId));
      const target = cohort?.children.find((entry) => entry.assignmentId === edge.assignmentId);
      if (target === undefined)
        reject(
          Code.MissingTarget,
          'Prerequisite target is outside this delivery or does not exist',
        );
      if (target.workItemId === child.workItemId)
        reject(Code.SelfDependency, 'A child cannot depend on itself');
      validateOutput(child, target, edge);
      return target.workItemId;
    }),
  };
}

function validateOutput(child: Child, target: Child, edge: DelegationPrerequisite): void {
  const output = target.outputs.find((entry) => entry.name === edge.output);
  if (output === undefined)
    reject(Code.MissingOutput, 'Prerequisite must select a declared named output');
  if (
    (edge.condition === Condition.AcceptedOutput && !('path' in output)) ||
    (requiresChange(edge) && !('kind' in output))
  )
    reject(Code.OutputKind, 'Prerequisite condition does not match the named output kind');
  if (edge.useAsBase) validateBase(child, target, edge);
  if (child.repository?.resourceId !== target.repository?.resourceId && 'kind' in output)
    reject(
      Code.CrossRepositoryChange,
      'Cross-repository prerequisites must select accepted context outputs',
    );
}

function validateBase(child: Child, target: Child, edge: DelegationPrerequisite): void {
  if (
    edge.condition === Condition.AcceptedOutput ||
    child.repository === undefined ||
    target.repository?.resourceId !== child.repository.resourceId
  )
    reject(Code.CrossRepositoryBase, 'Git bases require a same-repository change prerequisite');
}

async function mergeWaits(
  child: Child,
  all: readonly DelegationReservation[],
  definitions: WorkflowDefinitionRegistry,
  available: (target: Child, output: string) => Promise<boolean>,
) {
  const waits: [string, string][] = [];
  for (const [index, edge] of (child.prerequisites ?? []).entries()) {
    if (edge.condition !== Condition.MergedChange) continue;
    const upstream = all.find((entry) =>
      entry.children.some((target) => target.workItemId === child.prerequisiteWorkItemIds?.[index]),
    );
    const target = upstream?.children.find(
      (entry) => entry.workItemId === child.prerequisiteWorkItemIds?.[index],
    );
    if (upstream === undefined || target === undefined || (await available(target, edge.output)))
      continue;
    const workflow = await definitions.resolve(
      {
        workflowName: target.workflowName,
        workflowDefinitionFingerprint: target.workflowFingerprint,
      },
      { journalFallback: true },
    );
    // A delivery-ready child's parent must join before it can merge the child's output.
    if (!hasOwnMergeLane(workflow)) waits.push([target.workItemId, upstream.parentWorkItemId]);
  }
  return waits;
}

function assertAcyclic(graph: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const done = new Set<string>();

  function visit(node: string): void {
    if (visiting.has(node))
      reject(Code.WaitCycle, 'Prerequisites create an explicit or implicit join/merge wait cycle');
    if (done.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    done.add(node);
  }

  for (const node of graph.keys()) visit(node);
}

function reject(code: Code, message: string): never {
  throw new DelegationConflictError(code, message);
}

function requiresChange(edge: DelegationPrerequisite): boolean {
  return (
    edge.condition === Condition.PushedChange ||
    edge.condition === Condition.MergedChange ||
    edge.useAsBase === true
  );
}

function hasOwnMergeLane(workflow: CompiledWorkflow): boolean {
  return Object.values(workflow.stages).some(
    (stage) =>
      mergesPrimary(stage.activity, stage.with) ||
      Object.values(stage.on).some((route) =>
        route.activities?.some((activity) => mergesPrimary(activity.use, activity.with)),
      ),
  );
}

function mergesPrimary(activity: string, input: unknown): boolean {
  if (activity !== BuiltInActivityName.PullRequestMerge) return false;
  const parsed = pullRequestMergeInputSchema.safeParse(input);
  return parsed.success && parsed.data.target === ActivityResourceRole.Primary;
}

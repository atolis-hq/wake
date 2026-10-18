import { isDeepStrictEqual } from 'node:util';
import { UlidIdGenerator } from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import {
  delegatedAssignmentSchema,
  delegationReservationSchema,
  type DelegatedAssignment,
  type DelegationCaller,
  type DelegationLimits,
  type DelegationReservation,
} from '../contracts/delegation.js';
import { workflowInstanceId, type WorkflowInstanceId } from '../contracts/identifiers.js';

const ids = new UlidIdGenerator();

export interface ReservationParent {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly rootWorkItemId: WorkItemId;
  readonly ancestors: readonly WorkItemId[];
}

/** Child identities derive from root, cohort and assignment so replays name the same children. */
export function buildReservation(
  parent: ReservationParent,
  caller: DelegationCaller,
  cohortId: string,
  assignments: readonly DelegatedAssignment[],
  limits: DelegationLimits,
): DelegationReservation {
  const parsed = assignments.map((assignment) => delegatedAssignmentSchema.parse(assignment));
  if (new Set(parsed.map((assignment) => assignment.assignmentId)).size !== parsed.length)
    throw new Error('Duplicate assignment identity');
  for (const assignment of parsed) {
    if (new Set(assignment.outputs.map((output) => output.name)).size !== assignment.outputs.length)
      throw new Error('Duplicate named output');
  }
  return delegationReservationSchema.parse({
    cohortId,
    parentWorkflowInstanceId: parent.workflowInstanceId,
    parentWorkItemId: parent.workItemId,
    rootWorkItemId: parent.rootWorkItemId,
    activationId: caller.activationId,
    runId: caller.runId,
    ancestors: parent.ancestors,
    ...limits,
    children: parsed.map((assignment) => {
      const minted = ids.next('work');
      return {
        ...assignment,
        workItemId: workItemId(minted),
        workflowInstanceId: workflowInstanceId(`delegated:${minted}`),
        grantId: `child-${minted}`,
      };
    }),
  });
}

/** Identities are minted once and then committed, so replays compare the requested content only. */
export function sameDelegation(a: DelegationReservation, b: DelegationReservation): boolean {
  const content = (reservation: DelegationReservation) => ({
    ...reservation,
    runId: undefined,
    maxDepth: undefined,
    maxDescendants: undefined,
    children: reservation.children.map(
      ({ workItemId: _w, workflowInstanceId: _i, grantId: _g, ...assignment }) => assignment,
    ),
  });
  return isDeepStrictEqual(content(a), content(b));
}

/** Bounds are fixed by the first reservation under a root so nesting cannot widen them. */
export function assertWithinRootLimits(
  existing: readonly DelegationReservation[],
  reservation: DelegationReservation,
  limits: DelegationLimits,
): void {
  const rootLimits = existing[0] ?? limits;
  const reserved = existing.reduce((count, entry) => count + entry.children.length, 0);
  if (
    reservation.ancestors.length > rootLimits.maxDepth ||
    reserved + reservation.children.length > rootLimits.maxDescendants
  )
    throw new Error('Delegation root reservation limit exceeded');
}

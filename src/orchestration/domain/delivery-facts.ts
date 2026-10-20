import type { DelegationReservation, DelegationResult } from '../contracts/delegation.js';
import {
  DeliveryRejectionError,
  type DeliveryCandidate,
  type DeliveryOutputKey,
  type DeliveryQa,
  type DeliverySelection,
} from '../contracts/delivery.js';
import type { DeliveryRejection } from '../contracts/vocabulary.js';

export type Output = DelegationResult['outputs'][number];

export type Child = DelegationReservation['children'][number];

export type ChangeReference = Extract<
  Output['reference'],
  { readonly repositoryResourceId: string }
>;

/** Everything the delivery rules read; all of it is journal-derived. */
export interface DeliveryFacts {
  readonly reservations: readonly DelegationReservation[];
  readonly results: readonly DelegationResult[];
  /** Outputs each child consumed as prerequisites, by child WorkItem. */
  readonly consumed: ReadonlyMap<string, readonly Output[]>;
  readonly selections: readonly DeliverySelection[];
  readonly candidates: readonly DeliveryCandidate[];
  readonly qa: readonly DeliveryQa[];
}

export const outputKey = (key: DeliveryOutputKey) => `${key.childWorkItemId}/${key.outputName}`;

export const entryKey = (entry: { cohortId: string; assignmentId: string }, name: string) =>
  `${entry.cohortId}/${entry.assignmentId}/${name}`;

export const reject = (code: DeliveryRejection, message: string) =>
  new DeliveryRejectionError(code, message);

export const isChange = (output: Output): output is Output & { reference: ChangeReference } =>
  'repositoryResourceId' in output.reference;

export function currentSelection(facts: DeliveryFacts): DeliverySelection | undefined {
  return facts.selections.at(-1);
}

export interface Requirement {
  readonly cohortId: string;
  readonly assignmentId: string;
  readonly outputName: string;
  readonly child: Child;
  readonly criteria: readonly string[];
}

/** Original required assignments: those not themselves declared as a replacement. */
export function requirements(reservations: readonly DelegationReservation[]): Requirement[] {
  return reservations.flatMap((reservation) =>
    reservation.children
      .filter((child) => child.replaces === undefined)
      .flatMap((child) =>
        child.outputs.map((output) => ({
          cohortId: reservation.cohortId,
          assignmentId: child.assignmentId,
          outputName: output.name,
          child,
          criteria: child.criteria,
        })),
      ),
  );
}

export function childOf(reservations: readonly DelegationReservation[], id: string) {
  for (const reservation of reservations) {
    const child = reservation.children.find((entry) => entry.workItemId === id);
    if (child !== undefined) return { cohortId: reservation.cohortId, child };
  }
  return undefined;
}

export function qualifying(facts: DeliveryFacts, key: DeliveryOutputKey): Output | undefined {
  return facts.results
    .filter((result) => result.childWorkItemId === key.childWorkItemId)
    .flatMap((result) => result.outputs)
    .find((output) => output.name === key.outputName);
}

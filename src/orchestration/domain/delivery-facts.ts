import type { DelegationReservation, DelegationResult } from '../contracts/delegation.js';
import {
  DeliveryRejectionError,
  type DeliveryCandidate,
  type DeliveryMaintenance,
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
  /** Agent maintenance of selected changes, oldest first; each is a new immutable subject. */
  readonly maintenance: readonly DeliveryMaintenance[];
}

export const outputKey = (key: DeliveryOutputKey) => `${key.childWorkItemId}/${key.outputName}`;

export const entryKey = (entry: { cohortId: string; assignmentId: string }, name: string) =>
  `${entry.cohortId}/${entry.assignmentId}/${name}`;

export const reject = (code: DeliveryRejection, message: string) =>
  new DeliveryRejectionError(code, message);

export const isChange = (output: Output): output is Output & { reference: ChangeReference } =>
  'repositoryResourceId' in output.reference;

/**
 * The latest selection with each change at its newest maintained subject. The recorded selection
 * and every earlier subject stay in the journal; nothing else reads a stale head or base.
 */
export function currentSelection(facts: DeliveryFacts): DeliverySelection | undefined {
  const selection = facts.selections.at(-1);
  if (selection === undefined || facts.maintenance.length === 0) return selection;
  return {
    ...selection,
    entries: selection.entries.map((entry) => {
      const latest = facts.maintenance
        .filter(
          (item) =>
            item.target.childWorkItemId === entry.childWorkItemId &&
            item.target.outputName === entry.output.name,
        )
        .at(-1);
      if (latest === undefined || !isChange(entry.output)) return entry;
      return {
        ...entry,
        output: {
          ...entry.output,
          reference: {
            ...entry.output.reference,
            revision: latest.current.revision,
            pullRequestBase: latest.current.pullRequestBase,
            runId: latest.producer.runId,
            ...(latest.current.baseRevision === undefined
              ? {}
              : { baseRevision: latest.current.baseRevision }),
          },
        },
      };
    }),
  };
}

export interface Requirement {
  readonly cohortId: string;
  readonly assignmentId: string;
  readonly outputName: string;
  readonly child: Child;
  readonly criteria: readonly string[];
}

/** Original required assignments: those not themselves declared as a replacement. */
export function requirements(
  reservations: readonly DelegationReservation[],
  includeOptional = false,
): Requirement[] {
  return reservations.flatMap((reservation) =>
    reservation.children
      .filter((child) => child.replaces === undefined)
      .flatMap((child) =>
        child.outputs
          .filter((output) => includeOptional || output.required !== false)
          .map((output) => ({
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

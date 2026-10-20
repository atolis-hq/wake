import { isDeepStrictEqual } from 'node:util';
import type {
  DeliveryOutputKey,
  DeliverySelection,
  DeliverySelectionCommand,
  SelectedEntry,
} from '../contracts/delivery.js';
import { DeliveryRejection } from '../contracts/vocabulary.js';
import {
  childOf,
  currentSelection,
  entryKey,
  outputKey,
  qualifying,
  reject,
  requirements,
  type DeliveryFacts,
  type Output,
  type Requirement,
} from './delivery-facts.js';

type Entry = DeliverySelectionCommand['entries'][number];

/**
 * Validates a complete selection against the current one and the original requirements.
 * An omitted requirement is never a waiver: every original output must stay covered by its own
 * qualifying result or an authorized, criteria-preserving replacement that names the output
 * currently selected.
 */
export function reviseSelection(
  facts: DeliveryFacts,
  command: DeliverySelectionCommand,
): { readonly selection: DeliverySelection; readonly replay: boolean } {
  const prior = facts.selections.find((entry) => entry.requestId === command.requestId);
  const revision = currentSelection(facts)?.revision ?? 0;
  if (prior !== undefined) {
    if (prior.revision !== command.expectedRevision + 1 || !sameEntries(prior, command))
      throw reject(DeliveryRejection.Conflict, 'Selection request identity was reused');
    return { selection: prior, replay: true };
  }
  if (command.expectedRevision !== revision)
    throw reject(
      DeliveryRejection.StaleSelection,
      `Selection is at revision ${revision}, not ${command.expectedRevision}; inspect and retry`,
    );
  const required = requirements(facts.reservations);
  const available = requirements(facts.reservations, true);
  const seen = new Set<string>();
  const entries = command.entries.map((entry) => {
    const requirement = available.find(
      (candidate) =>
        candidate.cohortId === entry.cohortId &&
        candidate.assignmentId === entry.assignmentId &&
        candidate.outputName === entry.output.outputName,
    );
    if (requirement === undefined)
      throw reject(
        DeliveryRejection.UnknownRequirement,
        `${entryKey(entry, entry.output.outputName)} is not an original required output`,
      );
    const key = entryKey(entry, requirement.outputName);
    if (seen.has(key)) throw reject(DeliveryRejection.Conflict, `${key} is selected twice`);
    seen.add(key);
    return selected(facts, entry, requirement);
  });
  const missing = required.filter(
    (requirement) => !seen.has(entryKey(requirement, requirement.outputName)),
  );
  if (missing.length > 0)
    throw reject(
      DeliveryRejection.UncoveredRequirement,
      `Original requirements are not covered: ${missing
        .map((requirement) => entryKey(requirement, requirement.outputName))
        .join(', ')}`,
    );
  return {
    replay: false,
    selection: { requestId: command.requestId, revision: revision + 1, entries },
  };
}

function selected(facts: DeliveryFacts, entry: Entry, requirement: Requirement): SelectedEntry {
  const output = qualifying(facts, entry.output);
  if (output === undefined)
    throw reject(
      DeliveryRejection.OutputMismatch,
      `${outputKey(entry.output)} is not a qualifying result`,
    );
  if (entry.output.childWorkItemId === requirement.child.workItemId) {
    if (entry.replaces !== undefined)
      throw reject(
        DeliveryRejection.ReplacementConflict,
        `${entryKey(requirement, requirement.outputName)} is not a replacement`,
      );
  } else assertReplacement(facts, requirement, entry);
  return entryOf(entry, requirement, output);
}

function entryOf(entry: Entry, requirement: Requirement, output: Output): SelectedEntry {
  return {
    cohortId: requirement.cohortId,
    assignmentId: requirement.assignmentId,
    childWorkItemId: entry.output.childWorkItemId,
    output,
    ...(entry.replaces === undefined ? {} : { replaces: entry.replaces }),
  };
}

function assertReplacement(facts: DeliveryFacts, requirement: Requirement, entry: Entry): void {
  const key = entryKey(requirement, requirement.outputName);
  const found = childOf(facts.reservations, entry.output.childWorkItemId);
  if (
    found?.child.replaces?.cohortId !== requirement.cohortId ||
    found.child.replaces.assignmentId !== requirement.assignmentId
  )
    throw reject(
      DeliveryRejection.ReplacementConflict,
      `${outputKey(entry.output)} was not delegated as a replacement for ${key}`,
    );
  if (!requirement.criteria.every((criterion) => found.child.criteria.includes(criterion)))
    throw reject(
      DeliveryRejection.ReplacementConflict,
      `${outputKey(entry.output)} does not preserve the original acceptance criteria`,
    );
  const current = currentFor(facts, requirement);
  if (entry.replaces === undefined && outputKey(entry.output) === outputKey(current)) return;
  if (entry.replaces === undefined)
    throw reject(
      DeliveryRejection.ReplacementConflict,
      `${key} replacement must name the output it replaces`,
    );
  if (outputKey(entry.replaces) !== outputKey(current))
    throw reject(
      DeliveryRejection.ReplacementConflict,
      `${key} currently selects ${outputKey(current)}, not ${outputKey(entry.replaces)}`,
    );
}

function currentFor(facts: DeliveryFacts, requirement: Requirement): DeliveryOutputKey {
  const entry = currentSelection(facts)?.entries.find(
    (candidate) =>
      entryKey(candidate, candidate.output.name) === entryKey(requirement, requirement.outputName),
  );
  return entry === undefined
    ? { childWorkItemId: requirement.child.workItemId, outputName: requirement.outputName }
    : { childWorkItemId: entry.childWorkItemId, outputName: entry.output.name };
}

function sameEntries(prior: DeliverySelection, command: DeliverySelectionCommand): boolean {
  const priorKeys = prior.entries.map(
    (entry) => `${entryKey(entry, entry.output.name)}/${entry.childWorkItemId}`,
  );
  const commandKeys = command.entries.map(
    (entry) => `${entryKey(entry, entry.output.outputName)}/${entry.output.childWorkItemId}`,
  );
  return isDeepStrictEqual(priorKeys.sort(), commandKeys.sort());
}

/**
 * Selected results whose upstream input was replaced. A superseded output makes every consumer
 * stale, transitively; unrelated evidence is untouched and old facts stay in the history.
 */
export function staleEntries(facts: DeliveryFacts): ReadonlySet<string> {
  const current = currentSelection(facts);
  if (current === undefined) return new Set();
  const live = current.entries.map((entry) => entry.output.reference);
  const dead = facts.selections
    .flatMap((selection) => selection.entries)
    .flatMap((entry) => (entry.replaces === undefined ? [] : [qualifying(facts, entry.replaces)]))
    .flatMap((output) => (output === undefined ? [] : [output.reference]))
    .filter((reference) => !live.some((candidate) => sameRevision(candidate, reference)));
  const stale = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of current.entries) {
      const key = entryKey(entry, entry.output.name);
      const consumed = facts.consumed.get(entry.childWorkItemId) ?? [];
      if (stale.has(key) || !consumesAny(consumed, dead)) continue;
      stale.add(key);
      dead.push(entry.output.reference);
      changed = true;
    }
  }
  return stale;
}

const consumesAny = (consumed: readonly Output[], dead: readonly Output['reference'][]) =>
  consumed.some((input) => dead.some((reference) => sameRevision(reference, input.reference)));

/** Provider metadata can gain a base/merge observation without changing the consumed code. */
function sameRevision(a: Output['reference'], b: Output['reference']): boolean {
  if (a.workItemId !== b.workItemId) return false;
  if ('revisionId' in a) return 'revisionId' in b && a.revisionId === b.revisionId;
  return (
    !('revisionId' in b) &&
    a.resourceId === b.resourceId &&
    a.repositoryResourceId === b.repositoryResourceId &&
    a.revision === b.revision
  );
}

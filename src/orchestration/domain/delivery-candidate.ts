import { isDeepStrictEqual } from 'node:util';
import type {
  DeliveryCandidate,
  DeliveryCandidateCommand,
  DeliveryOutputKey,
  SelectedEntry,
} from '../contracts/delivery.js';
import { CandidateSourceKind, DeliveryRejection } from '../contracts/vocabulary.js';
import {
  currentSelection,
  isChange,
  outputKey,
  reject,
  requirements,
  type ChangeReference,
  type DeliveryFacts,
} from './delivery-facts.js';
import { staleEntries } from './delivery-selection.js';

type RepositoryRequest = DeliveryCandidateCommand['repositories'][number];

type CandidateRepository = DeliveryCandidate['repositories'][number];

export interface CandidatePlan {
  readonly candidate: DeliveryCandidate;
}

const sameKeys = (left: readonly DeliveryOutputKey[], right: readonly DeliveryOutputKey[]) =>
  isDeepStrictEqual(left.map(outputKey).sort(), right.map(outputKey).sort());

/** The namespace a delivery's candidate refs must live in; no automatic deletion is performed. */
export const retainedRefPrefix = (root: string, candidateId: string) =>
  `refs/wake/delivery/${root}/${candidateId}/`;

/** Shapes the candidate manifest from the current selection; source verification is separate. */
export function planCandidate(
  facts: DeliveryFacts,
  command: DeliveryCandidateCommand,
  root: string,
): CandidatePlan {
  const current = currentSelection(facts);
  if (current === undefined)
    throw reject(DeliveryRejection.NoSelection, 'Record a delivery selection first');
  if (command.selectionRevision !== current.revision)
    throw reject(
      DeliveryRejection.StaleSelection,
      `Selection is at revision ${current.revision}, not ${command.selectionRevision}`,
    );
  const stale = staleEntries(facts);
  if (stale.size > 0)
    throw reject(
      DeliveryRejection.StaleOutput,
      `Replace or reverify stale results first: ${[...stale].join(', ')}`,
    );
  const byRepository = new Map<string, SelectedEntry[]>();
  for (const entry of current.entries.filter((candidate) => isChange(candidate.output))) {
    const { repositoryResourceId } = entry.output.reference as ChangeReference;
    byRepository.set(repositoryResourceId, [
      ...(byRepository.get(repositoryResourceId) ?? []),
      entry,
    ]);
  }
  const requested = command.repositories.map((entry) => entry.resourceId);
  if (
    new Set(requested).size !== requested.length ||
    !isDeepStrictEqual([...requested].sort(), [...byRepository.keys()].sort())
  )
    throw reject(
      DeliveryRejection.CandidateCoverage,
      'The candidate must name exactly the repositories of the selected changes, once each',
    );
  const repositories = command.repositories.map((request) =>
    repositoryOf(request, byRepository.get(request.resourceId) ?? [], root, command.candidateId),
  );
  return {
    candidate: {
      candidateId: command.candidateId,
      selectionRevision: current.revision,
      repositories: repositories.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
      subjects: current.entries.flatMap((entry) =>
        isChange(entry.output)
          ? [
              {
                childWorkItemId: entry.childWorkItemId,
                outputName: entry.output.name,
                revision: entry.output.reference.revision,
                pullRequestBase: entry.output.reference.pullRequestBase,
                ...(entry.output.reference.baseRevision === undefined
                  ? {}
                  : { baseRevision: entry.output.reference.baseRevision }),
              },
            ]
          : [],
      ),
      context: current.entries
        .filter((entry) => !isChange(entry.output))
        .map((entry) => ({
          childWorkItemId: entry.childWorkItemId,
          outputName: entry.output.name,
        })),
      criteria: [
        ...new Set(requirements(facts.reservations).flatMap((requirement) => requirement.criteria)),
      ],
      ...(command.recipe === undefined ? {} : { recipe: command.recipe }),
    },
  };
}

function repositoryOf(
  request: RepositoryRequest,
  entries: readonly SelectedEntry[],
  root: string,
  candidateId: string,
): CandidateRepository {
  const expected = entries.map((entry) => ({
    childWorkItemId: entry.childWorkItemId,
    outputName: entry.output.name,
  }));
  const source = request.source;
  if (source.kind === CandidateSourceKind.Output) {
    if (!sameKeys([source.tip, ...(source.includes ?? [])], expected))
      throw reject(
        DeliveryRejection.CandidateCoverage,
        `Candidate for ${request.resourceId} must account for every selected change in it; independent changes need an assembled retained ref`,
      );
    const tip = entries.find((entry) => outputKey(source.tip) === outputKey(keyOf(entry)));
    if (tip === undefined)
      throw reject(DeliveryRejection.CandidateCoverage, 'The tip is not a selected change');
    const reference = tip.output.reference as ChangeReference;
    return {
      resourceId: request.resourceId,
      revision: reference.revision,
      pullRequestBase: reference.pullRequestBase,
      source: { kind: CandidateSourceKind.Output, tip: source.tip },
      contributions: expected,
    };
  }
  if (!sameKeys(source.contributions, expected))
    throw reject(
      DeliveryRejection.CandidateCoverage,
      `Assembly for ${request.resourceId} must declare every selected change in it`,
    );
  assertRetainedRef(source.ref, retainedRefPrefix(root, candidateId));
  const bases = entries.map((entry) => (entry.output.reference as ChangeReference).pullRequestBase);
  return {
    resourceId: request.resourceId,
    revision: source.revision,
    pullRequestBase: [...bases].sort()[0]!,
    source: { kind: CandidateSourceKind.RetainedRef, ref: source.ref },
    contributions: expected,
  };
}

const keyOf = (entry: SelectedEntry): DeliveryOutputKey => ({
  childWorkItemId: entry.childWorkItemId,
  outputName: entry.output.name,
});

function assertRetainedRef(ref: string, prefix: string): void {
  if (
    !ref.startsWith(prefix) ||
    ref.length === prefix.length ||
    !/^[A-Za-z0-9._/-]+$/.test(ref) ||
    ref.includes('..')
  )
    throw reject(DeliveryRejection.SourceUnavailable, `Retained refs must live under ${prefix}`);
}

import { isDeepStrictEqual } from 'node:util';
import type { DeliveryCandidate, DeliveryQa, DeliveryQaCommand } from '../contracts/delivery.js';
import { DeliveryCompletion, DeliveryRejection, QaVerdict } from '../contracts/vocabulary.js';
import { currentSelection, reject, type DeliveryFacts } from './delivery-facts.js';
import { staleEntries } from './delivery-selection.js';

/** The exact repository and revision set QA must have checked. */
export const revisionSet = (items: readonly { resourceId: string; revision: string }[]) =>
  items.map((item) => `${item.resourceId}@${item.revision.toLowerCase()}`).sort();

/** QA can only vouch for the candidate's own revisions, and never passes without an environment. */
export function assertQa(facts: DeliveryFacts, command: DeliveryQaCommand): DeliveryQa {
  const candidate = facts.candidates.find((entry) => entry.candidateId === command.candidateId);
  if (candidate === undefined)
    throw reject(DeliveryRejection.UnknownCandidate, `Unknown candidate ${command.candidateId}`);
  if (!isDeepStrictEqual(revisionSet(command.revisions), revisionSet(candidate.repositories)))
    throw reject(
      DeliveryRejection.RevisionMismatch,
      'QA must check exactly the candidate repository revisions; testing main or another candidate cannot satisfy the gate',
    );
  if (command.verdict === QaVerdict.Pass) assertPass(candidate, command);
  if (command.verdict === QaVerdict.Fail && command.findings.length === 0)
    throw reject(DeliveryRejection.InvalidVerdict, 'A failing verdict must state its findings');
  return { ...command };
}

function assertPass(candidate: DeliveryCandidate, command: DeliveryQaCommand): void {
  if (!command.environment.available)
    throw reject(
      DeliveryRejection.InvalidVerdict,
      'An unavailable environment is a blocker, never a pass',
    );
  if (command.findings.length > 0)
    throw reject(DeliveryRejection.InvalidVerdict, 'A passing verdict cannot carry findings');
  if (candidate.recipe !== undefined && command.environment.recipe !== candidate.recipe)
    throw reject(
      DeliveryRejection.InvalidVerdict,
      'QA must run the configured environment and test recipe',
    );
}

export interface DeliveryState {
  readonly selectionRevision: number;
  readonly stale: readonly string[];
  readonly candidate: DeliveryCandidate | null;
  /** The latest candidate belongs to the current selection and nothing in it is stale. */
  readonly candidateCurrent: boolean;
  readonly qa: DeliveryQa | null;
  /** The latest QA is for the current candidate; older verdicts stay historical. */
  readonly qaEffective: boolean;
  readonly repair: {
    readonly failedRounds: number;
    readonly exhausted: boolean;
    readonly unresolvedFindings: readonly string[];
  };
}

export function deliveryState(facts: DeliveryFacts): DeliveryState {
  const current = currentSelection(facts);
  const stale = [...staleEntries(facts)];
  const candidate = facts.candidates.at(-1) ?? null;
  const candidateCurrent =
    candidate !== null && candidate.selectionRevision === current?.revision && stale.length === 0;
  const qa =
    facts.qa.filter((entry) => entry.candidateId === candidate?.candidateId).at(-1) ?? null;
  const qaEffective = qa !== null && candidateCurrent;
  return {
    selectionRevision: current?.revision ?? 0,
    stale,
    candidate,
    candidateCurrent,
    qa,
    qaEffective,
    repair: {
      failedRounds: facts.qa.filter((entry) => entry.verdict === QaVerdict.Fail).length,
      exhausted: facts.qa.at(-1)?.exhausted === true,
      unresolvedFindings: qaEffective && qa.verdict !== QaVerdict.Pass ? qa.findings : [],
    },
  };
}

export interface CompletionDecision {
  readonly complete: boolean;
  readonly reason?: string;
}

/** DC-24 handoff boundary: QA approval finishes a QA-approved parent but never a merge-required one. */
export function completionDecision(
  state: DeliveryState,
  mode: DeliveryCompletion,
): CompletionDecision {
  if (state.stale.length > 0)
    return {
      complete: false,
      reason: `Stale results need reverification: ${state.stale.join(', ')}`,
    };
  if (state.candidate === null || !state.candidateCurrent)
    return { complete: false, reason: 'No current candidate has been recorded for the selection' };
  if (state.qa === null || !state.qaEffective)
    return { complete: false, reason: 'The current candidate has no QA result' };
  if (state.qa.verdict !== QaVerdict.Pass)
    return { complete: false, reason: `QA verdict is ${state.qa.verdict}` };
  if (mode === DeliveryCompletion.MergeRequired)
    return {
      complete: false,
      reason: 'Governed integration is required and its gates are not satisfied',
    };
  return { complete: true };
}

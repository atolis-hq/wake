import { isDeepStrictEqual } from 'node:util';
import type { DelegationArtifacts } from '../contracts/delegation-ports.js';
import type { DelegationInputs, DelegationReservation } from '../contracts/delegation.js';
import { PrerequisiteBlockCode as Code } from '../contracts/vocabulary.js';

export interface PrerequisiteBlock {
  readonly code: Code;
  readonly reason: string;
  readonly refresh?: DelegationInputs['consumed'];
}

export async function canRefreshInputs(
  stored: DelegationInputs['consumed'],
  current: DelegationInputs['consumed'],
  children: ReadonlyMap<string, DelegationReservation['children'][number]>,
  artifacts: DelegationArtifacts,
  revisions: ReadonlyMap<string, ReadonlySet<string>>,
  reviewRefreshes: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  if (stored.length !== current.length) return false;
  for (const [index, next] of current.entries()) {
    const previous = stored[index]!;
    if (isDeepStrictEqual(freshness([previous]), freshness([next]))) continue;
    if (!('runId' in previous.reference) || !('runId' in next.reference)) return false;
    const old = previous.reference;
    const fresh = next.reference;
    if (!sameChange(previous.name, next.name, old, fresh)) return false;
    const upstream = children.get(fresh.workItemId);
    const activation = await artifacts.runActivation?.(fresh.runId);
    if (
      upstream === undefined ||
      activation === undefined ||
      !isVerifiedRevision(
        upstream.workflowInstanceId,
        activation,
        fresh.revision,
        revisions,
        reviewRefreshes,
      )
    )
      return false;
  }
  return true;
}

export function freshness(outputs: DelegationInputs['consumed']) {
  return outputs.map(({ name, reference }) => {
    if (!('runId' in reference)) return { name, reference };
    const {
      runId: _run,
      baseRevision: _base,
      merged: _merged,
      pullRequestBase: _baseBranch,
      ...revision
    } = reference;
    return { name, reference: revision };
  });
}

export async function changedInputsBlock(
  ...args: Parameters<typeof canRefreshInputs>
): Promise<PrerequisiteBlock> {
  const refresh = await canRefreshInputs(...args);
  return {
    code: Code.Changed,
    reason: 'Consumed upstream output or base changed; agent assessment required',
    ...(refresh ? { refresh: args[1] } : {}),
  };
}

export function inheritedBlock(block: PrerequisiteBlock): PrerequisiteBlock {
  return block.refresh === undefined
    ? block
    : { code: Code.Waiting, reason: 'Waiting for upstream prerequisite refresh' };
}

type ChangeReference = Extract<
  DelegationInputs['consumed'][number]['reference'],
  { runId: string }
>;

function sameChange(oldName: string, name: string, old: ChangeReference, fresh: ChangeReference) {
  return (
    oldName === name &&
    old.workItemId === fresh.workItemId &&
    old.resourceId === fresh.resourceId &&
    old.repositoryResourceId === fresh.repositoryResourceId &&
    old.branch === fresh.branch &&
    old.revision !== fresh.revision
  );
}

function isVerifiedRevision(
  id: string,
  activation: string,
  revision: string,
  revisions: ReadonlyMap<string, ReadonlySet<string>>,
  refreshes: ReadonlyMap<string, ReadonlySet<string>>,
) {
  return revisions.get(id)?.has(activation) || refreshes.get(id)?.has(revision);
}

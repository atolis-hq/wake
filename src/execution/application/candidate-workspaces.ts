import { BuiltInResourceKind, type ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import { executionCandidateSchema, type ExecutionCandidate } from '../contracts/candidate.js';
import type { RunId } from '../contracts/identifiers.js';
import { WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';

/** A candidate is acquired as a unit; partial preparation never reaches a runner. */
export async function acquireCandidateWorkspaces(
  request: {
    readonly runId: RunId;
    readonly workItemId: WorkItemId;
    readonly candidate: ExecutionCandidate;
    readonly resources: readonly ResourceView[];
    readonly signal: AbortSignal;
  },
  provider: WorkspaceProvider | undefined,
): Promise<WorkspaceLease> {
  if (provider === undefined) throw new Error('Candidate QA needs a workspace provider');
  const candidate = executionCandidateSchema.parse(request.candidate);
  const assignments = [...candidate.repositories].sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId === b.resourceId ? 0 : 1,
  );
  if (new Set(assignments.map((entry) => entry.resourceId)).size !== assignments.length)
    throw new Error('Duplicate candidate repository');
  const leases: WorkspaceLease[] = [];
  try {
    for (const assignment of assignments) {
      request.signal.throwIfAborted();
      const resource = request.resources.find(
        (entry) =>
          entry.resourceId === assignment.resourceId &&
          entry.kind === BuiltInResourceKind.Repository,
      );
      if (resource === undefined) throw new Error('Candidate repository is unavailable');
      const { requiredSourceRef, ...repository } = assignment;
      const lease = await provider.acquire({
        runId: request.runId,
        workItemId: request.workItemId,
        signal: request.signal,
        mode: WorkspaceMode.ReadOnly,
        repositoryResource: resource,
        assignment: repository,
        checkoutRevision: assignment.sourceRevision,
        ...(requiredSourceRef === undefined ? {} : { requiredSourceRef }),
      });
      leases.push(lease);
      const revision = (await lease.readRevision?.()) ?? lease.checkoutRevision;
      if (revision !== assignment.sourceRevision)
        throw new Error('Prepared candidate checkout differs from its exact revision');
    }
    const first = leases[0]!;
    return {
      ...first,
      candidate: {
        candidateId: candidate.candidateId,
        selectionRevision: candidate.selectionRevision,
        repositories: assignments.map((entry, index) => ({
          resourceId: entry.resourceId,
          revision: entry.sourceRevision,
          path: leases[index]!.path,
        })),
      },
      release: () => releaseAll(leases),
    };
  } catch (error) {
    try {
      await releaseAll(leases);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Candidate preparation and cleanup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}

async function releaseAll(leases: readonly WorkspaceLease[]): Promise<void> {
  const failures: unknown[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Candidate lease cleanup failed');
}

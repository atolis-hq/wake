import { BuiltInResourceKind, type ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { RunId } from '../contracts/identifiers.js';
import { executionMaintenanceSchema, type ExecutionMaintenance } from '../contracts/maintenance.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';

/**
 * Leases the recorded branch workspace of every maintenance target as a unit, in a fixed order so
 * concurrent parents cannot deadlock. An unresolved earlier writer of any target stops the whole
 * preparation: it must be reconciled before another writer is allowed to act.
 */
export async function acquireMaintenanceWorkspaces(
  request: {
    readonly runId: RunId;
    readonly resources: readonly ResourceView[];
    readonly maintenance: ExecutionMaintenance;
    readonly runs: readonly RunView[];
    readonly signal: AbortSignal;
  },
  provider: WorkspaceProvider | undefined,
): Promise<WorkspaceLease> {
  if (provider === undefined) throw new Error('Maintenance needs a workspace provider');
  const maintenance = executionMaintenanceSchema.parse(request.maintenance);
  const targets = [...maintenance.targets].sort((a, b) =>
    a.childWorkItemId < b.childWorkItemId ? -1 : a.childWorkItemId === b.childWorkItemId ? 0 : 1,
  );
  if (new Set(targets.map((entry) => entry.childWorkItemId)).size !== targets.length)
    throw new Error('Duplicate maintenance target');
  for (const target of targets) {
    const unresolved = request.runs.find(
      (run) =>
        run.runId !== request.runId &&
        run.status === RunStatus.Ambiguous &&
        ((run.workspace?.branch === target.childWorkItemId &&
          run.workspace?.mode === WorkspaceMode.Branch) ||
          run.workspace?.maintenance?.targets.some(
            (entry) => entry.childWorkItemId === target.childWorkItemId,
          ) === true),
    );
    if (unresolved !== undefined)
      throw new Error(
        `Maintenance target ${target.childWorkItemId} has an unresolved earlier writer: Run ${unresolved.runId}`,
      );
  }
  const leases: WorkspaceLease[] = [];
  try {
    for (const target of targets) {
      request.signal.throwIfAborted();
      const resource = request.resources.find(
        (entry) =>
          entry.resourceId === target.repository.resourceId &&
          entry.kind === BuiltInResourceKind.Repository,
      );
      if (resource === undefined) throw new Error('Maintenance repository is unavailable');
      const lease = await provider.acquire({
        runId: request.runId,
        workItemId: target.childWorkItemId as WorkItemId,
        signal: request.signal,
        mode: WorkspaceMode.Branch,
        repositoryResource: resource,
        assignment: target.repository,
        checkoutRevision: target.revision,
      });
      leases.push(lease);
    }
    return {
      ...leases[0]!,
      maintenance: {
        targets: targets.map((target, index) => ({
          childWorkItemId: target.childWorkItemId,
          outputName: target.outputName,
          resourceId: target.resourceId,
          branch: target.branch,
          revision: target.revision,
          path: leases[index]!.path,
          ...(target.reason === undefined ? {} : { reason: target.reason }),
        })),
      },
      release: () => releaseAll(leases),
    };
  } catch (error) {
    try {
      await releaseAll(leases);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Maintenance preparation and cleanup failed', {
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
  if (failures.length > 0) throw new AggregateError(failures, 'Maintenance lease cleanup failed');
}

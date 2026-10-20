import { BuiltInResourceKind } from '../../resources/index.js';
import type { ChangeOutputWorkspace } from '../contracts/change-output.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { RunId } from '../contracts/identifiers.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';

interface ChangeOutputRequest {
  readonly runId: RunId;
  readonly context: ExecutionAttemptContext;
  readonly mode: typeof WorkspaceMode.Branch | typeof WorkspaceMode.ReadOnly;
  readonly runs: readonly RunView[];
  readonly signal: AbortSignal;
}

type OutputAssignment = NonNullable<ExecutionAttemptContext['changeOutputAssignments']>[number];

export function needsChangeOutputWorkspaces(
  context: ExecutionAttemptContext,
  activation: ExecutionActivation,
  runs: readonly RunView[],
): activation is ExecutionActivation & {
  readonly execution: {
    readonly workspace: typeof WorkspaceMode.Branch | typeof WorkspaceMode.ReadOnly;
  };
} {
  if (context.changeOutputAssignments?.some((output) => output.isolated === true) !== true)
    return false;
  if (activation.execution?.workspace === WorkspaceMode.Branch) return true;
  return (
    activation.execution?.workspace === WorkspaceMode.ReadOnly &&
    runs.some(
      (run) =>
        run.orchestrationGroupId === context.orchestrationGroupId &&
        run.changeOutputs !== undefined,
    )
  );
}

/** Lease all named branches in a stable order; retain the real child as each workspace owner. */
export async function acquireChangeOutputWorkspaces(
  request: ChangeOutputRequest,
  provider: WorkspaceProvider | undefined,
): Promise<WorkspaceLease> {
  if (provider === undefined) throw new Error('Named change outputs need a workspace provider');
  const { outputs, repository } = prepareOutputs(request);
  const leases: WorkspaceLease[] = [];
  const snapshots: ChangeOutputWorkspace[] = [];
  try {
    for (const output of outputs) {
      const previous = previousOutput(request, output.name);
      const lease = await provider.acquire({
        runId: request.runId,
        workItemId: request.context.workItemId,
        outputName: output.name,
        signal: request.signal,
        mode: request.mode,
        repositoryResource: repository,
        assignment: output.repository,
        checkoutRevision:
          request.mode === WorkspaceMode.ReadOnly
            ? (previous?.revision ?? output.repository.sourceRevision)
            : output.repository.sourceRevision,
      });
      leases.push(lease);
      snapshots.push(
        await snapshot(
          output,
          lease,
          request.mode === WorkspaceMode.Branch ? lease.branch : previous?.branch,
        ),
      );
    }
    return {
      ...leases[0]!,
      changeOutputs: snapshots,
      ...(request.mode === WorkspaceMode.Branch
        ? {
            readChangeOutputs: () =>
              Promise.all(
                snapshots.map(async (entry, index) => ({
                  ...entry,
                  revision: await readRevision(leases[index]!),
                })),
              ),
          }
        : {}),
      release: () => releaseAll(leases),
    };
  } catch (error) {
    try {
      await releaseAll(leases);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Change output preparation and cleanup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}

function prepareOutputs(request: ChangeOutputRequest) {
  const { context } = request;
  const outputs = [...(context.changeOutputAssignments ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const names = outputs.map((output) => output.name);
  const repository = context.resources.find(
    (entry) =>
      entry.resourceId === context.repositoryAssignment?.resourceId &&
      entry.kind === BuiltInResourceKind.Repository,
  );
  if (repository === undefined || names.length === 0)
    throw new Error('Assigned change output repository is unavailable');
  if (new Set(names).size !== names.length) throw new Error('Duplicate named change output');
  if (outputs.some((output) => output.repository.resourceId !== repository.resourceId))
    throw new Error('Change output is outside the assigned repository');
  if (request.runs.some((run) => ambiguousWriter(run, context)))
    throw new Error('Named change output has an unresolved earlier writer');
  return { outputs, repository };
}

function ambiguousWriter(run: RunView, context: ExecutionAttemptContext): boolean {
  return (
    run.status === RunStatus.Ambiguous &&
    ((run.orchestrationGroupId === context.orchestrationGroupId &&
      run.workspace?.mode === WorkspaceMode.Branch) ||
      run.workspace?.maintenance?.targets.some(
        (target) => target.childWorkItemId === context.workItemId,
      ) === true)
  );
}

function previousOutput(request: ChangeOutputRequest, name: string) {
  return request.runs
    .filter(
      (run) =>
        run.orchestrationGroupId === request.context.orchestrationGroupId &&
        run.status === RunStatus.Succeeded &&
        run.workspace?.mode === WorkspaceMode.Branch,
    )
    .flatMap((run) => run.changeOutputs ?? [])
    .filter((entry) => entry.name === name)
    .at(-1);
}

async function snapshot(
  output: OutputAssignment,
  lease: WorkspaceLease,
  branch: string | undefined,
): Promise<ChangeOutputWorkspace> {
  if (branch === undefined) throw new Error('Named change output workspace lacks attested branch');
  return {
    name: output.name,
    path: lease.path,
    branch,
    repository: output.repository,
    revision: await readRevision(lease),
  };
}

async function readRevision(lease: WorkspaceLease): Promise<string> {
  const revision = await lease.readRevision?.();
  if (revision === undefined) throw new Error('Change output HEAD is unavailable');
  return revision;
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
  if (failures.length > 0) throw new AggregateError(failures, 'Change output lease cleanup failed');
}

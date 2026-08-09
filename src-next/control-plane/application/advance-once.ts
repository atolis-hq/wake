/* eslint-disable complexity, max-lines-per-function */
import type { RunView } from '../../execution/index.js';
import { RunStatus } from '../../execution/index.js';
import {
  correlationId,
  EventActorKind,
  type Clock,
  type CommandContext,
  type IdGenerator,
} from '../../kernel/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../../orchestration/index.js';
import { WorkflowStatus } from '../../orchestration/index.js';
import type { ResourceService } from '../../resources/index.js';
import { ControlStreamKind } from '../contracts/streams.js';
import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';
import { DispatchPolicy } from '../domain/dispatch-policy.js';

interface OrchestrationPort {
  reconcileChildCompletions(context: CommandContext): Promise<void>;
  listPendingActivations(workItemId?: string): Promise<
    readonly {
      workflow: WorkflowInstanceView;
      activation: ActivityActivationView;
    }[]
  >;
  listWaiting(): Promise<readonly (WorkflowInstanceView | null)[]>;
  listAll?(): Promise<readonly WorkflowInstanceView[]>;
  acceptOutcome(
    command: {
      workflowInstanceId: string;
      activationId: string;
      outcome: NonNullable<RunView['outcome']>;
    },
    context: CommandContext,
  ): Promise<WorkflowInstanceView>;
  markActivationStarted(
    workflowInstanceId: string,
    activationId: string,
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
}

interface ExecutionPort {
  recoverActive?(owner: string): Promise<readonly RunView[]>;
  attempt(
    activation: ActivityActivationView,
    context: {
      workItemId: WorkflowInstanceView['workItemId'];
      workflowInstanceId: WorkflowInstanceView['workflowInstanceId'];
      orchestrationGroupId: WorkflowInstanceView['orchestrationGroupId'];
      resources: readonly NonNullable<Awaited<ReturnType<ResourceService['get']>>>[];
      ineligibleRunners?: ReadonlySet<string>;
    },
  ): Promise<RunView>;
  list(activationId?: ActivityActivationView['activationId']): Promise<readonly RunView[]>;
}

interface AdvanceOnceDependencies {
  readonly ids: IdGenerator;
  readonly work?: {
    get(
      workItemId: string,
    ): Promise<{ readonly frozen?: boolean; readonly deleted?: boolean } | null>;
  };
  readonly runnerIneligibility?: () => Promise<ReadonlySet<string>>;
  readonly isDispatchPaused?: () => Promise<boolean>;
  readonly dispatchPolicy?: DispatchPolicy;
}

export function createAdvanceOnce(
  orchestration: OrchestrationPort,
  execution: ExecutionPort,
  resources: ResourceService,
  clock: Clock,
  dependencies: AdvanceOnceDependencies,
) {
  const runnerIneligibility = dependencies.runnerIneligibility ?? (async () => new Set());
  const isDispatchPaused = dependencies.isDispatchPaused ?? (async () => false);
  const dispatchPolicy = dependencies.dispatchPolicy ?? new DispatchPolicy({ maxDispatches: 1 });
  const context = (cause: string) => ({
    commandId: dependencies.ids.next('command'),
    correlationId: correlationId(cause),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
  });
  return async (options: AdvanceOptions): Promise<AdvanceResult> => {
    if (options.maxProgress < 1) return { kind: 'exhausted', progressCount: 0 };
    if (await isDispatchPaused()) return { kind: 'paused' };
    await execution.recoverActive?.(ControlStreamKind.Global);
    await orchestration.reconcileChildCompletions(context('child-completion-reconciliation'));
    const rawPending = await orchestration.listPendingActivations(options.workItemId);
    const pending = (
      await Promise.all(
        rawPending.map(async (candidate) => {
          const work = await dependencies.work?.get(candidate.workflow.workItemId);
          return work?.frozen || work?.deleted ? null : candidate;
        }),
      )
    ).filter((candidate): candidate is (typeof rawPending)[number] => candidate !== null);
    const blocked = ((await orchestration.listAll?.()) ?? []).flatMap((workflow) =>
      workflow.status === WorkflowStatus.Blocked &&
      workflow.pendingActivation !== undefined &&
      (options.workItemId === undefined || workflow.workItemId === options.workItemId)
        ? [{ workflow, activation: workflow.pendingActivation }]
        : [],
    );
    const recovery = await findUnacceptedCompleted([...pending, ...blocked], execution);
    if (recovery !== undefined) {
      await orchestration.acceptOutcome(
        {
          workflowInstanceId: recovery.item.workflow.workflowInstanceId,
          activationId: recovery.item.activation.activationId,
          outcome: recovery.run.outcome!,
        },
        context(recovery.run.runId),
      );
      return {
        kind: 'progressed',
        activationId: recovery.item.activation.activationId,
        runId: recovery.run.runId,
      };
    }
    const selectedCandidate = dispatchPolicy.select(
      await Promise.all(
        pending.map(async (item, requestedPosition) => ({
          workItemId: item.workflow.workItemId,
          activationId: item.activation.activationId,
          requestedPosition,
          hasActiveRun: (await execution.list(item.activation.activationId)).some(
            (run) => run.status === RunStatus.Started,
          ),
          cancelled: false,
        })),
      ),
    )[0];
    const selected =
      selectedCandidate === undefined
        ? undefined
        : pending.find((item) => item.activation.activationId === selectedCandidate.activationId);
    if (selected === undefined) {
      const waiting = (await orchestration.listWaiting()).find((view) => view !== null);
      return waiting === undefined
        ? { kind: 'no-work' }
        : { kind: WorkflowStatus.Waiting, workflowInstanceId: waiting.workflowInstanceId };
    }
    await orchestration.markActivationStarted(
      selected.workflow.workflowInstanceId,
      selected.activation.activationId,
      context(selected.activation.activationId),
    );
    const correlated = await resources.correlationsForWork(selected.workflow.workItemId);
    const resourceViews = (
      await Promise.all(correlated.map((entry) => resources.get(entry.resourceId)))
    ).filter((resource) => resource !== null);
    const ineligible = await runnerIneligibility();
    const run = await execution.attempt(selected.activation, {
      workItemId: selected.workflow.workItemId,
      workflowInstanceId: selected.workflow.workflowInstanceId,
      orchestrationGroupId: selected.workflow.orchestrationGroupId,
      resources: resourceViews,
      ...(ineligible.size === 0 ? {} : { ineligibleRunners: ineligible }),
    });
    if (run.status === RunStatus.Succeeded && run.outcome !== undefined) {
      await orchestration.acceptOutcome(
        {
          workflowInstanceId: selected.workflow.workflowInstanceId,
          activationId: selected.activation.activationId,
          outcome: run.outcome,
        },
        context(run.runId),
      );
    }
    return run.status === RunStatus.Succeeded
      ? { kind: 'progressed', activationId: selected.activation.activationId, runId: run.runId }
      : {
          kind: WorkflowStatus.Blocked,
          workflowInstanceId: selected.workflow.workflowInstanceId,
          reason: run.failure?.message ?? 'execution failed',
        };
  };
}

async function findUnacceptedCompleted(
  pending: readonly { workflow: WorkflowInstanceView; activation: ActivityActivationView }[],
  execution: ExecutionPort,
): Promise<{ item: (typeof pending)[number]; run: RunView } | undefined> {
  for (const item of pending) {
    const run = (await execution.list(item.activation.activationId)).find(
      (candidate) => candidate.status === RunStatus.Succeeded && candidate.outcome !== undefined,
    );
    if (run !== undefined && !item.workflow.acceptedOutcomes.includes(item.activation.activationId))
      return { item, run };
  }
  return undefined;
}

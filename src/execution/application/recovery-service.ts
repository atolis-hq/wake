/* eslint-disable max-lines */
import type { ActivityOutcome, ActivityRegistry } from '../../activities/index.js';
import type { Clock, CommandContext, EventJournal } from '../../kernel/index.js';
import { correlationId, EventActorKind, EventSourceKind } from '../../kernel/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import type { RecoveryCoordinator } from '../contracts/control-plane.js';
import { createRunExecutionEventData } from '../contracts/event-factory.js';
import { ExecutionEventType, type RunExecutionEventData } from '../contracts/events.js';
import { runId, type RunId } from '../contracts/identifiers.js';
import type { AgentRunnerResult } from '../contracts/runner.js';
import { runStream } from '../contracts/streams.js';
import type { RunView } from '../contracts/views.js';
import {
  ExecutionFailureCode,
  ExternalExecutionState,
  isActiveRunStatus,
  RunStatus,
} from '../contracts/vocabulary.js';
import { RunRepository } from './run-repository.js';

export interface ExternalExecutionInspector {
  inspect(
    reference: NonNullable<RunView['externalExecution']>,
  ): Promise<
    | { readonly kind: typeof ExternalExecutionState.Running }
    | { readonly kind: typeof ExternalExecutionState.Completed; readonly result: AgentRunnerResult }
    | { readonly kind: typeof ExternalExecutionState.Absent }
    | { readonly kind: typeof ExternalExecutionState.Unknown; readonly reason: string }
  >;
}

export type AmbiguityResolution =
  | { readonly kind: typeof RunStatus.Succeeded; readonly outcome: unknown }
  | {
      readonly kind: typeof RunStatus.Failed;
      readonly failure: {
        readonly kind: typeof ExecutionFailureCode.Unexpected;
        readonly message: string;
      };
    };

export interface AmbiguityWorkflowBlocker {
  block(workflowInstanceId: string, reason: string, context: CommandContext): Promise<unknown>;
}

export class RecoveryService {
  private readonly repository: RunRepository;

  constructor(
    journal: EventJournal,
    private readonly clock: Clock,
    private readonly inspector: ExternalExecutionInspector,
    private readonly activities: Pick<ActivityRegistry, 'validateOutcome'>,
    private readonly config: Pick<
      ExecutionConfig,
      'leaseDurationMs' | 'leaseRenewalIntervalMs' | 'maxAmbiguityReconciliationAttempts'
    > = {},
    private readonly blocker?: AmbiguityWorkflowBlocker,
  ) {
    this.repository = new RunRepository(journal);
  }

  async recover(id: string, owner: string): Promise<RunView> {
    const currentRunId = runId(id);
    const loaded = await this.repository.load(currentRunId);
    const run = loaded.view;
    if (run === null || !isActiveRunStatus(run.status)) return requireRun(run);
    if (run.lease !== undefined && new Date(run.lease.expiresAt) > this.clock.now())
      throw new Error(`Run ${id} does not have an expired lease`);
    if (run.status === RunStatus.Starting)
      return this.appendFailure(
        currentRunId,
        run,
        'Preparation was interrupted before execution started',
      );
    if (run.externalExecution === undefined)
      return this.appendFailure(currentRunId, run, 'External execution was never reported');
    const inspection = await this.inspector.inspect(run.externalExecution);
    if (inspection.kind === ExternalExecutionState.Running)
      return this.appendLease(currentRunId, run, owner);
    if (inspection.kind === ExternalExecutionState.Completed)
      return this.appendRecovered(currentRunId, run, inspection.result);
    if (inspection.kind === ExternalExecutionState.Absent)
      return this.appendFailure(currentRunId, run, 'External execution is absent');
    return this.appendAmbiguity(currentRunId, run, inspection.reason);
  }

  async resolve(
    id: string,
    resolution: AmbiguityResolution,
    context: CommandContext,
  ): Promise<RunView> {
    if (context.actor.kind !== EventActorKind.Operator)
      throw new Error('Ambiguous Run resolution requires an operator actor');
    const currentRunId = runId(id);
    const loaded = await this.repository.load(currentRunId);
    if (loaded.view === null) throw new Error(`Run ${id} does not exist`);
    if (!loaded.view.escalated || loaded.view.status !== RunStatus.Ambiguous) {
      if (
        loaded.events?.some(
          (event) =>
            event.event.causationId === context.commandId &&
            (event.event.eventType === ExecutionEventType.RunSucceeded ||
              event.event.eventType === ExecutionEventType.RunFailed),
        )
      )
        return loaded.view;
      throw new Error(`Run ${id} is not escalated`);
    }
    const outcome =
      resolution.kind === RunStatus.Succeeded
        ? this.activities.validateOutcome(loaded.view.activity, resolution.outcome)
        : undefined;
    const draft =
      resolution.kind === RunStatus.Succeeded
        ? createRunExecutionEventData({
            ...resolutionMetadata(currentRunId, loaded.view, context),
            eventType: ExecutionEventType.RunSucceeded,
            payload: { outcome: outcome!, finishedAt: context.occurredAt },
          })
        : createRunExecutionEventData({
            ...resolutionMetadata(currentRunId, loaded.view, context),
            eventType: ExecutionEventType.RunFailed,
            payload: { failure: resolution.failure, finishedAt: context.occurredAt },
          });
    try {
      await this.repository.append(currentRunId, loaded.sequence, [draft]);
    } catch {
      // A concurrent resolution wins deterministically; return the resulting view.
    }
    return (await this.repository.load(currentRunId)).view!;
  }

  async recoverActive(
    owner: string,
    isLocallyActive: (runId: string) => boolean = () => false,
  ): Promise<readonly RunView[]> {
    const recovered: RunView[] = [];
    for (const run of await this.repository.list()) {
      if (!isActiveRunStatus(run.status)) continue;
      if (isLocallyActive(run.runId)) continue;
      if (run.lease !== undefined && new Date(run.lease.expiresAt) > this.clock.now()) continue;
      recovered.push(await this.recover(run.runId, owner));
    }
    return recovered;
  }

  private async appendLease(id: RunId, run: RunView, owner: string) {
    const now = this.clock.now().toISOString();
    return this.append(
      id,
      leaseRenewedDraft(
        id,
        run,
        {
          owner,
          acquiredAt: now,
          expiresAt: new Date(
            this.clock.now().getTime() + (this.config.leaseDurationMs ?? 60_000),
          ).toISOString(),
        },
        now,
      ),
    );
  }

  private async appendRecovered(id: RunId, run: RunView, result: AgentRunnerResult) {
    const finishedAt = this.clock.now().toISOString();
    const outcome = recoveredOutcome(run, result, this.activities);
    return this.append(id, recoveredDraft(id, run, { result, outcome, finishedAt }, finishedAt));
  }

  private async appendFailure(id: RunId, run: RunView, message: string) {
    const finishedAt = this.clock.now().toISOString();
    return this.append(
      id,
      failedDraft(
        id,
        run,
        { failure: { kind: ExecutionFailureCode.Unexpected, message }, finishedAt },
        finishedAt,
      ),
    );
  }

  private async appendAmbiguity(id: RunId, run: RunView, reason: string): Promise<RunView> {
    const loaded = await this.repository.load(id);
    if (loaded.view === null) throw new Error(`Run ${id} does not exist`);
    if (loaded.view.status !== RunStatus.Started) return loaded.view;
    const occurredAt = this.clock.now().toISOString();
    const attempt = loaded.view.ambiguityAttempts + 1;
    const drafts: RunExecutionEventData[] = [
      ambiguityObservedDraft(id, loaded.view, { reason, attempt }, occurredAt),
    ];
    if (attempt >= (this.config.maxAmbiguityReconciliationAttempts ?? 3))
      drafts.push(ambiguousDraft(id, loaded.view, { reason, finishedAt: occurredAt }, occurredAt));
    await this.repository.append(id, loaded.sequence, drafts);
    const updated = (await this.repository.load(id)).view!;
    if (updated.escalated)
      await this.blocker?.block(
        updated.workflowInstanceId,
        `run-ambiguous-after-${attempt}-attempts`,
        {
          commandId: `${id}:recovery-escalation:${attempt}`,
          correlationId: correlationId(updated.orchestrationGroupId),
          occurredAt,
          actor: { kind: EventActorKind.System, id: 'execution-recovery' },
        },
      );
    return updated;
  }

  private async append(id: RunId, draft: RunExecutionEventData): Promise<RunView> {
    const loaded = await this.repository.load(id);
    if (loaded.view === null) throw new Error(`Run ${id} does not exist`);
    if (!isActiveRunStatus(loaded.view.status)) return loaded.view;
    await this.repository.append(id, loaded.sequence, [draft]);
    return (await this.repository.load(id)).view!;
  }
}

export function createRecoveryCoordinator(service: RecoveryService): RecoveryCoordinator {
  return { recoverActive: (owner) => service.recoverActive(owner) };
}

function leaseRenewedDraft(
  id: RunId,
  run: RunView,
  payload: { readonly owner: string; readonly acquiredAt: string; readonly expiresAt: string },
  occurredAt: string,
): RunExecutionEventData {
  return createRunExecutionEventData({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunLeaseRenewed,
    payload,
  });
}

function recoveredDraft(
  id: RunId,
  run: RunView,
  payload: {
    readonly result: AgentRunnerResult;
    readonly outcome: ActivityOutcome;
    readonly finishedAt: string;
  },
  occurredAt: string,
): RunExecutionEventData {
  return createRunExecutionEventData({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunRecovered,
    payload,
  });
}

function failedDraft(
  id: RunId,
  run: RunView,
  payload: {
    readonly failure: {
      readonly kind: typeof ExecutionFailureCode.Unexpected;
      readonly message: string;
    };
    readonly finishedAt: string;
  },
  occurredAt: string,
): RunExecutionEventData {
  return createRunExecutionEventData({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunFailed,
    payload,
  });
}

function ambiguityObservedDraft(
  id: RunId,
  run: RunView,
  payload: { readonly reason: string; readonly attempt: number },
  occurredAt: string,
): RunExecutionEventData {
  return createRunExecutionEventData({
    ...eventMetadata(id, run, occurredAt),
    eventId: `${id}:recovery-ambiguity:${payload.attempt}:${occurredAt}`,
    eventType: ExecutionEventType.RunAmbiguityObserved,
    payload,
  });
}

function ambiguousDraft(
  id: RunId,
  run: RunView,
  payload: { readonly reason: string; readonly finishedAt: string },
  occurredAt: string,
): RunExecutionEventData {
  return createRunExecutionEventData({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunAmbiguous,
    payload,
  });
}

function resolutionMetadata(id: RunId, run: RunView, context: CommandContext) {
  return {
    eventId: `${context.commandId}:run-resolution`,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'execution-recovery' },
    stream: runStream(id),
  };
}

function eventMetadata(
  id: RunId,
  run: RunView,
  occurredAt: string,
): {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actor: { readonly kind: typeof EventActorKind.System; readonly id: string };
  readonly source: { readonly kind: typeof EventSourceKind.Internal; readonly id: string };
  readonly stream: ReturnType<typeof runStream>;
} {
  return {
    eventId: `${id}:recovery:${occurredAt}`,
    occurredAt,
    correlationId: run.orchestrationGroupId,
    causationId: run.activationId,
    actor: { kind: EventActorKind.System, id: 'execution-recovery' },
    source: { kind: EventSourceKind.Internal, id: 'execution-recovery' },
    stream: runStream(id),
  };
}

function recoveredOutcome(
  run: RunView,
  result: AgentRunnerResult,
  activities: Pick<ActivityRegistry, 'validateOutcome'>,
) {
  if (result.transport !== RunStatus.Succeeded)
    throw new Error(`Recovered result is not successful: ${result.transport}`);
  return activities.validateOutcome(run.activity, parseRecoveredOutput(result.output));
}

function parseRecoveredOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { kind: output.trim() };
  }
}

function requireRun(run: RunView | null): RunView {
  if (run === null) throw new Error('Run does not exist');
  return run;
}

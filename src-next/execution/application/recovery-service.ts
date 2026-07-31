import type { Clock, EventJournal } from '../../kernel/index.js';
import type { ActivityRegistry } from '../../activities/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import {
  ExecutionFailureCode,
  ExternalExecutionState,
  RunStatus,
} from '../contracts/vocabulary.js';
import type { RunnerResult } from '../contracts/runner.js';
import type { RunView } from '../contracts/views.js';
import { ExecutionEventType, type ExecutionEventDraft } from '../contracts/events.js';
import { createExecutionEventDraft } from '../contracts/event-factory.js';
import { runId, type RunId } from '../contracts/identifiers.js';
import { EventActorKind, EventSourceKind } from '../../kernel/index.js';
import { runStream } from '../contracts/streams.js';
import { RunRepository } from './run-repository.js';
import type { RecoveryCoordinator } from '../contracts/control-plane.js';

export interface ExternalExecutionInspector {
  inspect(
    reference: NonNullable<RunView['externalExecution']>,
  ): Promise<
    | { readonly kind: typeof ExternalExecutionState.Running }
    | { readonly kind: typeof ExternalExecutionState.Completed; readonly result: RunnerResult }
    | { readonly kind: typeof ExternalExecutionState.Absent }
    | { readonly kind: typeof ExternalExecutionState.Unknown; readonly reason: string }
  >;
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
      'leaseDurationMs' | 'leaseRenewalIntervalMs'
    > = {},
  ) {
    this.repository = new RunRepository(journal);
  }

  async recover(id: string, owner: string): Promise<RunView> {
    const currentRunId = runId(id);
    const loaded = await this.repository.load(currentRunId);
    const run = loaded.view;
    if (run === null || run.status !== RunStatus.Started) return requireRun(run);
    if (run.lease !== undefined && new Date(run.lease.expiresAt) > this.clock.now())
      throw new Error(`Run ${id} does not have an expired lease`);
    if (run.externalExecution === undefined)
      return this.appendFailure(currentRunId, run, 'External execution was never reported');
    const inspection = await this.inspector.inspect(run.externalExecution);
    if (inspection.kind === ExternalExecutionState.Running)
      return this.appendLease(currentRunId, run, owner);
    if (inspection.kind === ExternalExecutionState.Completed)
      return this.appendRecovered(currentRunId, run, inspection.result);
    if (inspection.kind === ExternalExecutionState.Absent)
      return this.appendFailure(currentRunId, run, 'External execution is absent');
    return this.appendAmbiguous(currentRunId, run, inspection.reason);
  }

  async recoverActive(owner: string): Promise<readonly RunView[]> {
    const recovered: RunView[] = [];
    for (const run of await this.repository.list()) {
      if (run.status !== RunStatus.Started) continue;
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
  private async appendRecovered(id: RunId, run: RunView, result: RunnerResult) {
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
  private async appendAmbiguous(id: RunId, run: RunView, reason: string) {
    const finishedAt = this.clock.now().toISOString();
    return this.append(id, ambiguousDraft(id, run, { reason, finishedAt }, finishedAt));
  }
  private async append(id: RunId, draft: ExecutionEventDraft): Promise<RunView> {
    const loaded = await this.repository.load(id);
    if (loaded.view === null) throw new Error(`Run ${id} does not exist`);
    if (loaded.view.status !== RunStatus.Started) return loaded.view;
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
): ExecutionEventDraft {
  return createExecutionEventDraft({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunLeaseRenewed,
    payload,
  });
}
function recoveredDraft(
  id: RunId,
  run: RunView,
  payload: {
    readonly result: RunnerResult;
    readonly outcome: import('../../activities/index.js').ActivityOutcome;
    readonly finishedAt: string;
  },
  occurredAt: string,
): ExecutionEventDraft {
  return createExecutionEventDraft({
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
): ExecutionEventDraft {
  return createExecutionEventDraft({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunFailed,
    payload,
  });
}
function ambiguousDraft(
  id: RunId,
  run: RunView,
  payload: { readonly reason: string; readonly finishedAt: string },
  occurredAt: string,
): ExecutionEventDraft {
  return createExecutionEventDraft({
    ...eventMetadata(id, run, occurredAt),
    eventType: ExecutionEventType.RunAmbiguous,
    payload,
  });
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
  result: RunnerResult,
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

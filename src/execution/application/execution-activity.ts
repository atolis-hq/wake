import { type ActivityExecutionContext, type ActivityRegistry } from '../../activities/index.js';
import { type Clock, type EventJournal, type IdGenerator } from '../../kernel/index.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import type { ExecutionConfig } from '../contracts/config.js';
import { ExecutionEventType, type RunExecutionEventDraft } from '../contracts/events.js';
import type { runId } from '../contracts/identifiers.js';
import type { WorkspaceProvider } from '../contracts/workspace.js';
import { parseAgentRunnerResponse } from '../infrastructure/agent-runner-adapter.js';
import type { RunnerRegistry } from '../infrastructure/runners/registry.js';
import { createRunEvent } from './run-lifecycle.js';
import type { RunRepository } from './run-repository.js';

export interface ExecutionDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly workspaces?: WorkspaceProvider;
  readonly runners?: RunnerRegistry;
  readonly transcriptRecorder?: ActivityExecutionContext['transcriptRecorder'];
  readonly logOperationalError?: ActivityExecutionContext['logOperationalError'];
  readonly reportRunnerQuota?: (input: {
    readonly runnerName: string;
    readonly message: string;
  }) => Promise<void>;
}

export interface ExecutionRuntime {
  readonly activities: ActivityRegistry;
  readonly config: ExecutionConfig;
  readonly dependencies: ExecutionDependencies;
  readonly repository: RunRepository;
  readonly active: Map<string, AbortController>;
  readonly journal: EventJournal;
}

export async function executeActivity(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  request: {
    readonly activation: ExecutionActivation;
    readonly context: ExecutionAttemptContext;
    readonly occurredAt: string;
    readonly runner: ActivityExecutionContext['runner'];
    readonly runnerName?: string;
    readonly runnerCli?: string;
    readonly runnerModel?: string;
    readonly runnerEffort?: string;
    readonly resumeSessionId?: string;
    readonly usageBaseline?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    };
    readonly workspace?: ActivityExecutionContext['workspace'];
  },
) {
  const { activation, context, occurredAt, runner } = request;
  const controller = new AbortController();
  runtime.active.set(currentRunId, controller);
  const executionContext: ActivityExecutionContext = {
    signal: controller.signal,
    occurredAt,
    runId: currentRunId,
    ...(request.resumeSessionId === undefined ? {} : { resumeSessionId: request.resumeSessionId }),
    ...(request.usageBaseline === undefined ? {} : { usageBaseline: request.usageBaseline }),
    ...workspaceContext(request.workspace),
    ...(runner === undefined ? {} : { runner }),
    ...(runtime.dependencies.transcriptRecorder === undefined
      ? {}
      : { transcriptRecorder: runtime.dependencies.transcriptRecorder }),
    ...(runtime.dependencies.logOperationalError === undefined
      ? {}
      : { logOperationalError: runtime.dependencies.logOperationalError }),
    ...(request.runnerName === undefined
      ? {}
      : {
          runnerContext: {
            runnerName: request.runnerName,
            ...(request.runnerCli === undefined ? {} : { runnerCli: request.runnerCli }),
            activationOrdinal: activation.ordinal,
            ...(request.runnerModel === undefined ? {} : { model: request.runnerModel }),
            ...(request.runnerEffort === undefined ? {} : { effort: request.runnerEffort }),
          },
        }),
    reportExternalExecution: externalExecutionReporter(runtime, currentRunId, context, activation),
    reportRunnerResult: runnerResultReporter(runtime, currentRunId, context, activation, request),
  };
  return runtime.activities.execute(
    {
      activationId: activation.activationId,
      activity: activation.activity,
      workItemId: context.workItemId,
      workflowInstanceId: context.workflowInstanceId,
      orchestrationGroupId: context.orchestrationGroupId,
      causationId: activation.activationId,
      input: activation.input,
      resources: context.resources,
    },
    executionContext,
  );
}

function externalExecutionReporter(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  context: ExecutionAttemptContext,
  activation: ExecutionActivation,
): ActivityExecutionContext['reportExternalExecution'] {
  return async (reference) => {
    const loaded = await runtime.repository.load(currentRunId);
    await runtime.repository.append(currentRunId, loaded.sequence, [
      createRunEvent({
        runId: currentRunId,
        eventId: `${currentRunId}:external:${reference.id}`,
        eventType: ExecutionEventType.RunExternalExecutionReported,
        occurredAt: runtime.dependencies.clock.now().toISOString(),
        correlationId: context.orchestrationGroupId,
        causationId: activation.activationId,
        payload: reference,
      }),
    ]);
  };
}

function runnerResultReporter(
  runtime: ExecutionRuntime,
  currentRunId: ReturnType<typeof runId>,
  context: ExecutionAttemptContext,
  activation: ExecutionActivation,
  request: { readonly runnerName?: string },
): NonNullable<ActivityExecutionContext['reportRunnerResult']> {
  return async (result) => {
    const loaded = await runtime.repository.load(currentRunId);
    const event = createRunEvent({
      runId: currentRunId,
      eventId: `${currentRunId}:runner-result`,
      eventType: ExecutionEventType.RunRunnerResultReported,
      occurredAt: runtime.dependencies.clock.now().toISOString(),
      correlationId: context.orchestrationGroupId,
      causationId: activation.activationId,
      payload: { transport: result.transport, agent: parseAgentRunnerResponse(result) },
    }) as RunExecutionEventDraft;
    await appendIdempotently(runtime.repository, currentRunId, loaded.sequence, event);
    if (result.failure?.kind === 'provider-quota-exceeded' && request.runnerName !== undefined)
      await runtime.dependencies.reportRunnerQuota?.({
        runnerName: request.runnerName,
        message: result.failure.message,
      });
  };
}

function workspaceContext(workspace: ActivityExecutionContext['workspace']) {
  return workspace === undefined ? {} : { workspace };
}

async function appendIdempotently(
  repository: RunRepository,
  currentRunId: ReturnType<typeof runId>,
  sequence: number,
  event: RunExecutionEventDraft,
): Promise<void> {
  try {
    await repository.append(currentRunId, sequence, [event]);
  } catch {
    const current = await repository.load(currentRunId);
    await repository.append(currentRunId, current.sequence, [event]);
  }
}

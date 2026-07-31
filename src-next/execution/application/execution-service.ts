import { ActivityResourceCardinality } from '../../activities/index.js';
import { RunStatus, WorkspaceMode } from '../contracts/vocabulary.js';
import { EventActorKind, EventSourceKind } from '../../kernel/index.js';
import {
  type ActivityRegistry,
  type ActivityExecutionContext,
  type ResourceRequirement,
} from '../../activities/index.js';
import {
  createEventDraft,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import { BuiltInResourceKind, type ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../contracts/commands.js';
import { ExecutionEventType, type ExecutionEventPayloads } from '../contracts/events.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind, runStream } from '../contracts/streams.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { RunRepository } from './run-repository.js';

export function createExecutionService(
  journal: EventJournal,
  activities: ActivityRegistry,
  config: ExecutionConfig,
  dependencies: {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly workspaces?: WorkspaceProvider;
  },
) {
  const repository = new RunRepository(journal);
  return {
    async attempt(activation: ExecutionActivation, context: ExecutionAttemptContext) {
      const definition = activities.describe(activation.activity);
      activities.validateInput(activation.activity, activation.input);
      validateResources(definition.resources, context.resources);
      const tier = activation.execution?.tier ?? config.defaultTier;
      if (config.tiers[tier] === undefined) throw new Error(`Unknown execution tier: ${tier}`);
      const prior = await repository.list(activation.activationId);
      const completed = prior.find((run) => run.status === RunStatus.Succeeded);
      if (completed !== undefined) return completed;
      const currentRunId = runId(dependencies.ids.next(ExecutionStreamKind.Run));
      const startedAt = dependencies.clock.now().toISOString();
      let lease: WorkspaceLease | undefined;
      try {
        lease = await acquireWorkspace(
          activation.execution?.workspace ?? WorkspaceMode.None,
          context.workItemId,
          context.resources,
          dependencies.workspaces,
        );
        await repository.append(currentRunId, 0, [
          event({
            runId: currentRunId,
            eventId: `${currentRunId}:started`,
            eventType: ExecutionEventType.RunStarted,
            occurredAt: startedAt,
            correlationId: context.orchestrationGroupId,
            causationId: activation.activationId,
            payload: {
              activationId: activation.activationId,
              activity: activation.activity,
              workflowInstanceId: context.workflowInstanceId,
              orchestrationGroupId: context.orchestrationGroupId,
              attempt: prior.length + 1,
              startedAt,
              ...(lease === undefined ? {} : { workspace: { mode: lease.mode, path: lease.path } }),
            },
          }),
        ]);
        const outcome = await executeActivity(activities, {
          activation,
          context,
          occurredAt: startedAt,
        });
        const finishedAt = dependencies.clock.now().toISOString();
        await repository.append(currentRunId, 1, [
          event({
            runId: currentRunId,
            eventId: `${currentRunId}:succeeded`,
            eventType: ExecutionEventType.RunSucceeded,
            occurredAt: finishedAt,
            correlationId: context.orchestrationGroupId,
            causationId: activation.activationId,
            payload: { outcome, finishedAt },
          }),
        ]);
      } catch (error) {
        const loaded = await repository.load(currentRunId);
        if (loaded.sequence > 0) {
          const finishedAt = dependencies.clock.now().toISOString();
          await repository.append(currentRunId, loaded.sequence, [
            event({
              runId: currentRunId,
              eventId: `${currentRunId}:failed`,
              eventType: ExecutionEventType.RunFailed,
              occurredAt: finishedAt,
              correlationId: context.orchestrationGroupId,
              causationId: activation.activationId,
              payload: { failure: failureFrom(error), finishedAt },
            }),
          ]);
        } else throw error;
      } finally {
        await lease?.release();
      }
      return (await repository.load(currentRunId)).view!;
    },
    list: (activationId?: ExecutionActivation['activationId']) => repository.list(activationId),
  };
}
async function executeActivity(
  activities: ActivityRegistry,
  request: {
    readonly activation: ExecutionActivation;
    readonly context: ExecutionAttemptContext;
    readonly occurredAt: string;
  },
) {
  const { activation, context, occurredAt } = request;
  const executionContext: ActivityExecutionContext = {
    signal: new AbortController().signal,
    occurredAt,
    async reportExternalExecution() {},
  };
  return activities.execute(
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
async function acquireWorkspace(
  mode: typeof WorkspaceMode.None | typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch,
  workItemId: WorkItemId,
  resources: readonly ResourceView[],
  provider?: WorkspaceProvider,
): Promise<WorkspaceLease | undefined> {
  if (mode === WorkspaceMode.None) return undefined;
  if (provider === undefined) throw new Error('Workspace provider is required');
  const repositoryResource = resources.find(
    (resource) => resource.kind === BuiltInResourceKind.Repository,
  );
  if (repositoryResource === undefined) throw new Error('Repository Resource is required');
  return provider.acquire({ mode, workItemId, repositoryResource });
}
function event<Type extends keyof ExecutionEventPayloads>(input: {
  runId: ReturnType<typeof runId>;
  eventId: string;
  eventType: Type;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  payload: ExecutionEventPayloads[Type];
}) {
  return createEventDraft({
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor: { kind: EventActorKind.System, id: 'execution' },
    source: { kind: EventSourceKind.Internal, id: 'execution' },
    stream: runStream(input.runId),
    payload: input.payload,
  });
}
function validateResources(
  requirements: readonly ResourceRequirement[],
  resources: readonly ResourceView[],
): void {
  for (const requirement of requirements) {
    const count = resources.filter((resource) =>
      resource.capabilities.includes(requirement.capability),
    ).length;
    if (requirement.cardinality === ActivityResourceCardinality.ExactlyOne && count !== 1)
      throw new Error(`Activity requires exactly one ${requirement.capability} Resource`);
    if (requirement.cardinality === ActivityResourceCardinality.OneOrMore && count < 1)
      throw new Error(`Activity requires ${requirement.capability} Resources`);
    if (requirement.cardinality === ActivityResourceCardinality.ZeroOrOne && count > 1)
      throw new Error(`Activity allows at most one ${requirement.capability} Resource`);
  }
}

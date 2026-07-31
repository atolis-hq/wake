import { ActivityResourceCardinality, WorkspaceMode } from '../../activities/index.js';
import { RunStatus } from '../contracts/vocabulary.js';
import { EventActorKind, EventSourceKind } from '../../kernel/index.js';
import {
  activityName,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  type ActivityRegistry,
  type ActivityExecutionContext,
  type ActivationId,
  type ActivityName,
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
import { ExecutionEventType, type ExecutionEventPayloads } from '../contracts/events.js';
import { runId } from '../contracts/identifiers.js';
import { ExecutionStreamKind, runStream } from '../contracts/streams.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { RunRepository } from './run-repository.js';

interface Activation {
  readonly activationId: ActivationId;
  readonly ordinal: number;
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly execution:
    | {
        readonly workspace?:
          | typeof WorkspaceMode.None
          | typeof WorkspaceMode.ReadOnly
          | typeof WorkspaceMode.Branch
          | undefined;
        readonly tier?: string | undefined;
      }
    | undefined;
}
interface AttemptContext {
  readonly workItemId: WorkItemId;
  readonly workflowInstanceId: string;
  readonly orchestrationGroupId: string;
  readonly resources: readonly ResourceView[];
}

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
    async attempt(activation: Activation, context: AttemptContext) {
      const definition = activities.get(activityName(activation.activity));
      const input = activities.validateInput(activation.activity, activation.input);
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
              attempt: prior.length + 1,
              startedAt,
              ...(lease === undefined ? {} : { workspace: { mode: lease.mode, path: lease.path } }),
            },
          }),
        ]);
        const outcome = await executeActivity(activities, definition, {
          activation,
          context,
          input,
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
    list: (activationId?: string) => repository.list(activationId),
  };
}
async function executeActivity(
  activities: ActivityRegistry,
  definition: ReturnType<ActivityRegistry['get']>,
  request: {
    readonly activation: Activation;
    readonly context: AttemptContext;
    readonly input: unknown;
    readonly occurredAt: string;
  },
) {
  const { activation, context, input, occurredAt } = request;
  const executionContext: ActivityExecutionContext = {
    signal: new AbortController().signal,
    occurredAt,
    async reportExternalExecution() {},
  };
  return activities.execute(
    definition,
    {
      activationId: activation.activationId,
      activity: activation.activity,
      workItemId: context.workItemId,
      workflowInstanceId: activityWorkflowInstanceId(context.workflowInstanceId),
      orchestrationGroupId: activityOrchestrationGroupId(context.orchestrationGroupId),
      causationId: activation.activationId,
      input,
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
  requirements: readonly { capability: string; cardinality: string }[],
  resources: readonly ResourceView[],
): void {
  for (const requirement of requirements) {
    const count = resources.filter((resource) =>
      resource.capabilities.includes(requirement.capability as never),
    ).length;
    if (requirement.cardinality === ActivityResourceCardinality.ExactlyOne && count !== 1)
      throw new Error(`Activity requires exactly one ${requirement.capability} Resource`);
    if (requirement.cardinality === ActivityResourceCardinality.OneOrMore && count < 1)
      throw new Error(`Activity requires ${requirement.capability} Resources`);
    if (requirement.cardinality === ActivityResourceCardinality.ZeroOrOne && count > 1)
      throw new Error(`Activity allows at most one ${requirement.capability} Resource`);
  }
}

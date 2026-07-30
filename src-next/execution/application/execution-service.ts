import type { ActivityRegistry, ActivityExecutionContext } from '../../activities/index.js';
import {
  createEventDraft,
  entityRef,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ExecutionConfig } from '../contracts/config.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';
import { failureFrom } from '../domain/run-result.js';
import { RunRepository } from './run-repository.js';

interface Activation {
  readonly activationId: string;
  readonly ordinal: number;
  readonly activity: string;
  readonly input: unknown;
  readonly execution:
    | {
        readonly workspace?: 'none' | 'read-only' | 'branch' | undefined;
        readonly tier?: string | undefined;
      }
    | undefined;
  readonly status: 'pending' | 'running' | 'completed';
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
      const definition = activities.get(activation.activity);
      const input = activities.validateInput(activation.activity, activation.input);
      validateResources(definition.resources, context.resources);
      const tier = activation.execution?.tier ?? config.defaultTier;
      if (config.tiers[tier] === undefined) throw new Error(`Unknown execution tier: ${tier}`);
      const prior = await repository.list(activation.activationId);
      const completed = prior.find((run) => run.status === 'succeeded');
      if (completed !== undefined) return completed;
      const runId = dependencies.ids.next('run');
      const startedAt = dependencies.clock.now().toISOString();
      let lease: WorkspaceLease | undefined;
      try {
        lease = await acquireWorkspace(
          activation.execution?.workspace ?? 'none',
          context.workItemId,
          context.resources,
          dependencies.workspaces,
        );
        await repository.append(runId, 0, [
          event({
            runId,
            eventId: `${runId}:started`,
            eventType: 'execution.run-started',
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
        const outcome = activities.validateOutcome(
          activation.activity,
          await executeActivity(definition, activation, context, input),
        );
        const finishedAt = dependencies.clock.now().toISOString();
        await repository.append(runId, 1, [
          event({
            runId,
            eventId: `${runId}:succeeded`,
            eventType: 'execution.run-succeeded',
            occurredAt: finishedAt,
            correlationId: context.orchestrationGroupId,
            causationId: activation.activationId,
            payload: { outcome, finishedAt },
          }),
        ]);
      } catch (error) {
        const loaded = await repository.load(runId);
        if (loaded.sequence > 0) {
          const finishedAt = dependencies.clock.now().toISOString();
          await repository.append(runId, loaded.sequence, [
            event({
              runId,
              eventId: `${runId}:failed`,
              eventType: 'execution.run-failed',
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
      return (await repository.load(runId)).view!;
    },
    list: (activationId?: string) => repository.list(activationId),
  };
}
async function executeActivity(
  definition: ReturnType<ActivityRegistry['get']>,
  activation: Activation,
  context: AttemptContext,
  input: unknown,
) {
  const executionContext: ActivityExecutionContext = {
    signal: new AbortController().signal,
    async reportExternalExecution() {},
  };
  return definition.handler.execute(
    {
      activationId: activation.activationId,
      activity: activation.activity,
      workItemId: context.workItemId,
      workflowInstanceId: context.workflowInstanceId,
      orchestrationGroupId: context.orchestrationGroupId,
      causationId: activation.activationId,
      input,
      resources: context.resources,
    },
    executionContext,
  );
}
async function acquireWorkspace(
  mode: 'none' | 'read-only' | 'branch',
  workItemId: WorkItemId,
  resources: readonly ResourceView[],
  provider?: WorkspaceProvider,
): Promise<WorkspaceLease | undefined> {
  if (mode === 'none') return undefined;
  if (provider === undefined) throw new Error('Workspace provider is required');
  const repositoryResource = resources.find((resource) => resource.kind === 'repository');
  if (repositoryResource === undefined) throw new Error('Repository Resource is required');
  return provider.acquire({ mode, workItemId, repositoryResource });
}
function event(input: {
  runId: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  payload: unknown;
}) {
  return createEventDraft({
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor: { kind: 'system', id: 'execution' },
    source: { kind: 'internal', id: 'execution' },
    stream: entityRef('run', input.runId),
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
    if (requirement.cardinality === 'exactly-one' && count !== 1)
      throw new Error(`Activity requires exactly one ${requirement.capability} Resource`);
    if (requirement.cardinality === 'one-or-more' && count < 1)
      throw new Error(`Activity requires ${requirement.capability} Resources`);
    if (requirement.cardinality === 'zero-or-one' && count > 1)
      throw new Error(`Activity allows at most one ${requirement.capability} Resource`);
  }
}

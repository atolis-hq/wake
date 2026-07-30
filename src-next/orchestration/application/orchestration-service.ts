import type { ActivityOutcome } from '../../activities/index.js';
import type { CommandContext, EventJournal } from '../../kernel/index.js';
import type { WorkService } from '../../work/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import { acceptActivityOutcome, startInstance } from '../domain/interpreter.js';
import { OrchestrationRepository } from './orchestration-repository.js';
export function createOrchestrationService(
  journal: EventJournal,
  work: WorkService,
  definitions: Readonly<Record<string, CompiledWorkflow>>,
) {
  const repository = new OrchestrationRepository(journal);
  return {
    async start(command: StartWorkflowInstance, context: CommandContext) {
      const item = await work.get(command.workItemId);
      if (item === null || item.state !== 'open')
        throw new Error('WorkItem must exist and be open');
      const definition = definitions[command.workflowName];
      if (definition === undefined) throw new Error(`Unknown workflow: ${command.workflowName}`);
      const existing = await repository.load(command.workflowInstanceId);
      if (existing.view !== null) return existing.view;
      const decision = startInstance({
        ...command,
        definition,
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
      });
      if (decision.kind === 'append')
        await repository.append(command.workflowInstanceId, 0, decision.events);
      return (await repository.load(command.workflowInstanceId)).view!;
    },
    async acceptOutcome(
      command: { workflowInstanceId: string; activationId: string; outcome: ActivityOutcome },
      context: CommandContext,
    ) {
      const loaded = await repository.load(command.workflowInstanceId);
      if (loaded.view === null) throw new Error('WorkflowInstance does not exist');
      const definition = definitions[loaded.view.workflowName]!;
      const decision = acceptActivityOutcome(definition, loaded.view, {
        ...command,
        occurredAt: context.occurredAt,
        causationId: context.commandId,
      });
      if (decision.kind === 'append')
        await repository.append(command.workflowInstanceId, loaded.sequence, decision.events);
      return (await repository.load(command.workflowInstanceId)).view!;
    },
    async markActivationStarted(
      workflowInstanceId: string,
      activationId: string,
      context: CommandContext,
    ) {
      const loaded = await repository.load(workflowInstanceId);
      if (loaded.view?.pendingActivation?.activationId !== activationId) return loaded.view;
      const event = (await import('../../kernel/index.js')).createEventDraft({
        eventId: `${context.commandId}:orchestration.activity-started`,
        eventType: 'orchestration.activity-started',
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
        actor: context.actor,
        source: { kind: 'internal' as const, id: 'orchestration-service' },
        stream: (await import('../../kernel/index.js')).entityRef(
          'workflow-instance',
          workflowInstanceId,
        ),
        payload: { activationId },
      });
      await repository.append(workflowInstanceId, loaded.sequence, [event]);
      return (await repository.load(workflowInstanceId)).view;
    },
    async get(id: string) {
      return (await repository.load(id)).view;
    },
    async listPendingActivations(workItemId?: string) {
      return (await repository.list())
        .filter(
          (view) =>
            view !== null &&
            view.status === 'active' &&
            view.pendingActivation !== undefined &&
            (workItemId === undefined || view.workItemId === workItemId),
        )
        .map((view) => ({ workflow: view!, activation: view!.pendingActivation! }));
    },
    async listWaiting(signalKind?: string) {
      void signalKind;
      return (await repository.list()).filter((view) => view?.status === 'waiting');
    },
    async listAll() {
      return (await repository.list()).filter((view) => view !== null);
    },
  };
}

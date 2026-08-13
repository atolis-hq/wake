import { createEventDraft, EventSourceKind, type CommandContext } from '../../kernel/index.js';
import { WorkStatus, type WorkService } from '../../work/index.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { WorkflowName } from '../contracts/identifiers.js';
import { WorkflowInstanceKind } from '../contracts/vocabulary.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import { validateChildProvenance } from '../domain/child-policy.js';
import { startInstance } from '../domain/interpreter.js';
import type { CoordinationClaims } from './coordination-claims.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import {
  WorkflowDefinitionRegistry,
  WorkflowDefinitionUnavailableError,
} from './workflow-definition-registry.js';

export class StartWorkflow {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly claims: CoordinationClaims,
    private readonly work: WorkService,
    private readonly definitions: WorkflowDefinitionRegistry,
  ) {}

  async execute(command: StartWorkflowInstance, context: CommandContext) {
    const item = await this.work.get(command.workItemId);
    if (item === null || item.state !== WorkStatus.Open)
      throw new Error('WorkItem must exist and be open');
    const { definition, fingerprint } = this.definitions.currentDefinition(command.workflowName);
    const existing = await this.repository.load(command.workflowInstanceId);
    if (existing.view !== null) return existing.view;
    const startKind = validateChildProvenance(command);
    if (startKind === WorkflowInstanceKind.Primary) {
      await this.claims.claimPrimary(command.workItemId, command.workflowInstanceId, context);
    } else {
      const parent = await this.repository.loadRequired(command.parentWorkflowInstanceId!);
      if (
        parent.view.workItemId !== command.workItemId ||
        parent.view.orchestrationGroupId !== command.orchestrationGroupId
      )
        throw new Error('Child workflow must share its parent WorkItem and orchestration group');
    }
    await this.definitions.register(command.workflowName, fingerprint, definition, context);
    const decision = startInstance({
      ...command,
      definition,
      workflowDefinitionFingerprint: fingerprint,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
    });
    if (decision.kind === 'append')
      await this.repository.append(command.workflowInstanceId, 0, decision.events);
    return (await this.repository.loadRequired(command.workflowInstanceId)).view;
  }

  definition(name: WorkflowName) {
    return this.definitions.currentDefinition(name).definition;
  }

  definitionFor(view: Parameters<WorkflowDefinitionRegistry['resolve']>[0]) {
    return this.definitions.resolve(view);
  }

  async definitionForOperation(
    view: WorkflowInstanceView,
    sequence: number,
    context: CommandContext,
  ) {
    try {
      return await this.definitions.resolve(view);
    } catch (error) {
      if (!(error instanceof WorkflowDefinitionUnavailableError)) throw error;
      if (view.status !== 'blocked')
        await this.repository.append(view.workflowInstanceId, sequence, [
          createEventDraft({
            eventId: `${context.commandId}:${OrchestrationEventType.InstanceBlocked}`,
            eventType: OrchestrationEventType.InstanceBlocked,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
            stream: workflowInstanceStream(view.workflowInstanceId),
            payload: { reason: 'workflow-definition-unavailable' },
          }),
        ]);
      return null;
    }
  }
}

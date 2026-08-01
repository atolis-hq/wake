import type { CommandContext } from '../../kernel/index.js';
import { WorkStatus, type WorkService } from '../../work/index.js';
import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowName } from '../contracts/identifiers.js';
import { WorkflowInstanceKind } from '../contracts/vocabulary.js';
import { validateChildProvenance } from '../domain/child-policy.js';
import { startInstance } from '../domain/interpreter.js';
import type { CoordinationClaims } from './coordination-claims.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

export class StartWorkflow {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly claims: CoordinationClaims,
    private readonly work: WorkService,
    private readonly definitions: Readonly<Record<string, CompiledWorkflow>>,
  ) {}

  async execute(command: StartWorkflowInstance, context: CommandContext) {
    const item = await this.work.get(command.workItemId);
    if (item === null || item.state !== WorkStatus.Open)
      throw new Error('WorkItem must exist and be open');
    const definition = this.definition(command.workflowName);
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
    const decision = startInstance({
      ...command,
      definition,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
    });
    if (decision.kind === 'append')
      await this.repository.append(command.workflowInstanceId, 0, decision.events);
    return (await this.repository.loadRequired(command.workflowInstanceId)).view;
  }

  definition(name: WorkflowName): CompiledWorkflow {
    const definition = this.definitions[name];
    if (definition === undefined) throw new Error(`Unknown workflow: ${name}`);
    return definition;
  }
}

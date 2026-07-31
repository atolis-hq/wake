import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { orchestrationActivityOutcome } from '../contracts/activity-outcome.js';
import { acceptActivityOutcome as decideActivityOutcome } from '../domain/interpreter.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

interface AcceptActivityOutcomeCommand {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly activationId: ActivationId;
  readonly outcome: ActivityOutcome;
}

export class AcceptActivityOutcome {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly workflows: StartWorkflow,
    private readonly reconcileChildCompletions: (context: CommandContext) => Promise<void>,
  ) {}

  async execute(command: AcceptActivityOutcomeCommand, context: CommandContext) {
    const loaded = await this.repository.loadRequired(command.workflowInstanceId);
    const decision = decideActivityOutcome(
      this.workflows.definition(loaded.view.workflowName),
      loaded.view,
      {
        ...command,
        outcome: orchestrationActivityOutcome(command.outcome),
        occurredAt: context.occurredAt,
        causationId: context.commandId,
      },
    );
    if (decision.kind === 'append')
      await this.repository.append(command.workflowInstanceId, loaded.sequence, decision.events);
    await this.reconcileChildCompletions(context);
    return (await this.repository.loadRequired(command.workflowInstanceId)).view;
  }
}

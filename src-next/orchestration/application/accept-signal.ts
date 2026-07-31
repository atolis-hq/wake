import type { CommandContext } from '../../kernel/index.js';
import type { OrchestrationSignal, SignalExpectation } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import {
  acceptSignal as decideSignal,
  waitForSignal as decideSignalWait,
} from '../domain/interpreter.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

export class AcceptSignal {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly workflows: StartWorkflow,
  ) {}

  async wait(
    workflowInstanceId: WorkflowInstanceId,
    expectation: SignalExpectation,
    context: CommandContext,
  ) {
    const loaded = await this.repository.loadRequired(workflowInstanceId);
    const decision = decideSignalWait(loaded.view, expectation, {
      occurredAt: context.occurredAt,
      causationId: context.commandId,
    });
    if (decision.kind === 'ignored') throw new Error(decision.reason);
    await this.repository.append(workflowInstanceId, loaded.sequence, decision.events);
    return (await this.repository.loadRequired(workflowInstanceId)).view;
  }

  async execute(
    workflowInstanceId: WorkflowInstanceId,
    signal: OrchestrationSignal,
    context: CommandContext,
  ) {
    const loaded = await this.repository.loadRequired(workflowInstanceId);
    const decision = decideSignal(
      this.workflows.definition(loaded.view.workflowName),
      loaded.view,
      {
        signal,
        occurredAt: context.occurredAt,
        causationId: context.commandId,
      },
    );
    if (decision.kind === 'append')
      await this.repository.append(workflowInstanceId, loaded.sequence, decision.events);
    return (await this.repository.loadRequired(workflowInstanceId)).view;
  }
}

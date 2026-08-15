import type { CommandContext } from '../../kernel/index.js';
import type { WorkService } from '../../work/index.js';
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
    private readonly work: WorkService,
    private readonly resolveEventTransitions?: (
      context: CommandContext,
      candidate: {
        readonly workflowInstanceId: WorkflowInstanceId;
        readonly providerEventId: string;
      },
    ) => Promise<boolean>,
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
    if (
      (await this.resolveEventTransitions?.(context, {
        workflowInstanceId,
        providerEventId: signal.providerEventId,
      })) === true
    )
      return (await this.repository.loadRequired(workflowInstanceId)).view;
    const loaded = await this.repository.loadRequired(workflowInstanceId);
    const item = await this.work.get(loaded.view.workItemId);
    const definition = await this.workflows.definitionForOperation(
      loaded.view,
      loaded.sequence,
      context,
    );
    if (definition === null) return (await this.repository.loadRequired(workflowInstanceId)).view;
    const decision = decideSignal(definition, loaded.view, {
      signal,
      occurredAt: context.occurredAt,
      causationId: context.commandId,
      consent: item?.autoApprovalGranted ?? false,
    });
    if (decision.kind === 'append')
      await this.repository.append(workflowInstanceId, loaded.sequence, decision.events);
    return (await this.repository.loadRequired(workflowInstanceId)).view;
  }
}

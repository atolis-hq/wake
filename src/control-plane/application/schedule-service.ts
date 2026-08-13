import { correlationId, type CommandContext, type IdGenerator } from '../../kernel/index.js';
import type { StartWorkflowInstance } from '../../orchestration/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../orchestration/index.js';
import type { CreateWorkItem } from '../../work/index.js';
import { workItemId } from '../../work/index.js';
import type { ScheduleConfig } from '../contracts/config.js';
import { SchedulePolicy } from '../domain/schedule-policy.js';

export interface ScheduleCheckpointStore {
  load(scheduleId: string): Promise<string | null>;
  save(scheduleId: string, slot: string): Promise<void>;
}

export interface ScheduleServiceDependencies {
  readonly checkpoint: ScheduleCheckpointStore;
  readonly ids: IdGenerator;
  readonly work: {
    create(command: CreateWorkItem, context: CommandContext): Promise<unknown>;
  };
  readonly orchestration: Pick<
    {
      start(command: StartWorkflowInstance, context: CommandContext): Promise<unknown>;
      get(
        id: ReturnType<typeof workflowInstanceId>,
      ): Promise<{ readonly workItemId: ReturnType<typeof workItemId> } | null>;
    },
    'start' | 'get'
  >;
  readonly now: () => string;
}

export class ScheduleService {
  private readonly policy = new SchedulePolicy();

  constructor(private readonly dependencies: ScheduleServiceDependencies) {}

  async run(config: ScheduleConfig, context: CommandContext): Promise<readonly string[]> {
    const checkpoint = await this.dependencies.checkpoint.load(config.id);
    const slots = this.policy.elapsedSlots(config, this.dependencies.now(), checkpoint);
    const accepted: string[] = [];
    for (const slot of slots) {
      const workflow = workflowInstanceId(`workflow-${safe(slot.at)}`);
      const slotContext = slotCommandContext(context, slot.identity);
      const existing = await this.dependencies.orchestration.get(workflow);
      const item = existing?.workItemId ?? workItemId(this.dependencies.ids.next('work'));
      if (existing === null) {
        const workCommand: CreateWorkItem = { workItemId: item, objective: config.objective };
        await this.dependencies.work.create(workCommand, slotContext);
      }
      const start: StartWorkflowInstance = {
        workflowInstanceId: workflow,
        workItemId: item,
        workflowName: workflowName(config.workflow),
        orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
      };
      await this.dependencies.orchestration.start(start, slotContext);
      await this.dependencies.checkpoint.save(config.id, slot.at);
      accepted.push(slot.identity);
    }
    return accepted;
  }
}

function slotCommandContext(context: CommandContext, identity: string): CommandContext {
  const suffix = safe(identity);
  return {
    ...context,
    commandId: `${context.commandId}:${suffix}`,
    correlationId: correlationId(`${context.correlationId}:${suffix}`),
  };
}

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

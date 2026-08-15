import {
  correlationId,
  EventActorKind,
  type CheckpointStore,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { TransitionTarget } from '../contracts/config.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { ResourceTransitionEvidence } from './resource-transition-evidence.js';
import type { ResourceTransitionMatch } from './resource-transition-matching.js';

type PersistedEvent = Parameters<typeof selectOrchestrationEvent>[0];

interface ResourceTransitionOrchestrationPort {
  listResourceTransitionMatches(event: PersistedEvent): Promise<readonly ResourceTransitionMatch[]>;
  applyResourceTransition(
    workflowInstanceId: WorkflowInstanceId,
    target: TransitionTarget,
    evidenceId: string,
    context: CommandContext,
  ): Promise<unknown>;
}

const checkpoint = 'reactor:orchestration.resource-transition';
const batchSize = 100;

export function createResourceTransitionReactor(
  orchestration: ResourceTransitionOrchestrationPort,
  evidence: ResourceTransitionEvidence,
  journal?: EventJournal,
  checkpoints?: CheckpointStore,
) {
  let queue: Promise<unknown> = Promise.resolve();
  const react = async (event: PersistedEvent, context: CommandContext): Promise<void> => {
    const orchestrationEvent = selectOrchestrationEvent(event);
    const isWaitStart = orchestrationEvent?.eventType === OrchestrationEventType.SignalWaitStarted;
    if (!isWaitStart && !evidence.triggers.includes(event.eventType)) return;
    const fact = isWaitStart ? undefined : event;
    for (const match of await orchestration.listResourceTransitionMatches(event)) {
      const resolved = await evidence.resolve({
        workItemId: match.workItemId,
        transitions: match.transitions,
        ...(fact === undefined ? {} : { fact }),
      });
      if (resolved === null) continue;
      await orchestration.applyResourceTransition(
        match.workflowInstanceId,
        resolved.transition.target,
        resolved.evidenceId,
        context,
      );
    }
  };
  const runBatch = async (limit = batchSize): Promise<number> => {
    if (journal === undefined || checkpoints === undefined)
      throw new Error('ResourceTransitionReactor journal and checkpoints are required to run');
    const events = await journal.readAll(await checkpoints.load(checkpoint), limit);
    for (const event of events) {
      await react(event, commandContext(event));
      await checkpoints.save(checkpoint, event.globalPosition);
    }
    return events.length;
  };
  const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  return {
    react,
    runOnce(limit = batchSize): Promise<number> {
      return serialize(() => runBatch(limit));
    },
    drain(): Promise<number> {
      return serialize(async () => {
        let total = 0;
        let processed: number;
        do {
          processed = await runBatch();
          total += processed;
        } while (processed === batchSize);
        return total;
      });
    },
  };
}

function commandContext(event: PersistedEvent): CommandContext {
  return {
    commandId: `${event.eventId}:resource-transition`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: EventActorKind.System, id: 'resource-transition-reactor' },
  };
}

import { scanJournal, yieldScan, type EventEnvelope, type EventJournal } from '@atolis-hq/eventing';
import { median, type ReportQuery } from '../../kernel/index.js';
import { selectWorkEvent, WorkEventType } from '../../work/index.js';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';

interface CompletionFacts {
  readonly created: Map<string, number>;
  readonly instances: Map<string, string>;
  readonly completed: Map<string, number>;
}

export async function queryWorkCompletionSummary(journal: EventJournal, query: ReportQuery) {
  const facts: CompletionFacts = { created: new Map(), instances: new Map(), completed: new Map() };
  for await (const event of scanJournal(journal, query.signal)) acceptFact(facts, event);
  const from = Date.parse(query.window.from),
    to = Date.parse(query.window.to);
  let workItemsDone = 0,
    processed = 0;
  const durations: number[] = [];
  for (const [id, end] of facts.completed) {
    if (processed++ % 100 === 0) await yieldScan(query.signal);
    if (!(end >= from && end < to)) continue;
    workItemsDone++;
    const start = facts.created.get(id);
    if (start !== undefined && Number.isFinite(start) && end >= start) durations.push(end - start);
  }
  return {
    workItemsDone,
    medianEndToEndDurationMs: await median(durations, () => yieldScan(query.signal)),
  };
}

function acceptFact(facts: CompletionFacts, event: EventEnvelope): void {
  const work = selectWorkEvent(event);
  if (work?.event.eventType === WorkEventType.ItemCreated)
    facts.created.set(work.stream.id, Date.parse(work.event.occurredAt));
  const workflow = selectWorkflowOrchestrationEvent(event);
  if (workflow === null) return;
  switch (workflow.event.eventType) {
    case OrchestrationEventType.InstanceStarted:
      if (!('parentWorkflowInstanceId' in workflow.event.payload))
        facts.instances.set(workflow.stream.id, workflow.event.payload.workItemId);
      return;
    case OrchestrationEventType.InstanceCompleted: {
      const id = facts.instances.get(workflow.stream.id);
      if (id !== undefined && !facts.completed.has(id))
        facts.completed.set(id, Date.parse(workflow.event.occurredAt));
      return;
    }
    default:
      return;
  }
}

import type { createStateStore } from '../adapters/fs/state-store.js';
import { AUTONOMOUS_DECISION_AUDIT_EVENT } from '../domain/schema.js';
import type { EventEnvelope } from '../domain/types.js';

type StateStore = ReturnType<typeof createStateStore>;

function formatValue(value: unknown): string {
  if (value === undefined) return 'n/a';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function auditEventsForWorkItem(events: EventEnvelope[], workItemKey: string): EventEnvelope[] {
  return events
    .filter(
      (event) =>
        event.workItemKey === workItemKey &&
        event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT,
    )
    .sort((left, right) => left.ingestedAt.localeCompare(right.ingestedAt));
}

export async function runAuditCommand(input: {
  args: string[];
  stateStore: StateStore;
  log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? console.log;
  const [workItemKey] = input.args;
  if (workItemKey === undefined) {
    throw new Error('Usage: wake audit <workItemKey>');
  }

  const events = auditEventsForWorkItem(await input.stateStore.listEventEnvelopes(), workItemKey);
  if (events.length === 0) {
    log(`No autonomous audit events found for ${workItemKey}.`);
    return;
  }

  log(`Autonomous audit history for ${workItemKey}`);
  for (const event of events) {
    const payload = event.payload;
    log('');
    log(`${formatValue(payload.timestamp)}  ${formatValue(payload.decisionType)}`);
    log(`  runId: ${formatValue(payload.runId)}`);
    log(`  workflowRevision: ${formatValue(payload.workflowRevision)}`);
    log(`  inputsConsidered: ${formatValue(payload.inputsConsidered)}`);
    log(`  outcome: ${formatValue(payload.outcome)}`);
  }
}

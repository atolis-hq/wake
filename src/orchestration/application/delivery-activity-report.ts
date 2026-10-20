import { scanJournal, yieldScan, type EventEnvelope, type EventJournal } from '@atolis-hq/eventing';
import { ExecutionEventType, selectRunExecutionEvent } from '../../execution/index.js';
import {
  defineClosedVocabulary,
  type ReportDefinition,
  type ReportQuery,
  type TimeSeriesReport,
} from '../../kernel/index.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { readCompletionFacts, type CompletionFacts } from './work-completion-summary.js';

export const DeliveryActivityReportId = defineClosedVocabulary({
  Activity: 'delivery-activity',
} as const);

export const DeliveryActivityMeasure = defineClosedVocabulary({
  RootDeliveries: 'root-deliveries',
  AcceptedChildResults: 'accepted-child-results',
  CorrectiveActivations: 'corrective-activations',
} as const);

const descriptor = { id: DeliveryActivityReportId.Activity, title: 'Delivery activity' };

const series = [
  { id: DeliveryActivityMeasure.RootDeliveries, title: 'Root deliveries', unit: 'work items' },
  {
    id: DeliveryActivityMeasure.AcceptedChildResults,
    title: 'Accepted child results',
    unit: 'results',
  },
  {
    id: DeliveryActivityMeasure.CorrectiveActivations,
    title: 'Corrective activations',
    unit: 'activations',
  },
];

export function createDeliveryActivityReport(journal: EventJournal): ReportDefinition {
  return { ...descriptor, query: (query) => queryDeliveryActivity(journal, query) };
}

/**
 * Counts three distinct populations that must never be summed into one throughput figure:
 * - root deliveries: the first primary completion of each non-delegated WorkItem;
 * - accepted child results: one per (cohort, child) durable result selection;
 * - corrective activations: activations that actually started a Run and carry explicit durable
 *   correction provenance, bucketed by the earliest Run start of the activation. Provenance is
 *   a reservation assignment that `replaces` an original, or a recorded maintenance producer.
 *   QA activations and stage names are never inferred as correction.
 */
interface DeliveryFacts {
  readonly resultTimes: Map<string, number>;
  readonly correctiveInstances: Set<string>;
  readonly correctiveActivations: Set<string>;
  readonly runs: { activationId: string; workflowInstanceId: string; startedAt: number }[];
}

function acceptDeliveryFact(facts: DeliveryFacts, event: EventEnvelope): void {
  const run = selectRunExecutionEvent(event);
  if (run !== null) {
    if (
      run.event.eventType === ExecutionEventType.RunPreparationStarted ||
      run.event.eventType === ExecutionEventType.RunStarted
    )
      facts.runs.push({
        activationId: run.event.payload.activationId,
        workflowInstanceId: run.event.payload.workflowInstanceId,
        startedAt: Date.parse(run.event.payload.startedAt),
      });
    return;
  }
  const owned = selectOrchestrationEvent(event);
  if (owned === null) return;
  switch (owned.event.eventType) {
    case OrchestrationEventType.DelegationReserved:
      for (const child of owned.event.payload.children)
        if (child.replaces !== undefined) facts.correctiveInstances.add(child.workflowInstanceId);
      return;
    case OrchestrationEventType.DeliveryMaintenanceRecorded:
      facts.correctiveActivations.add(owned.event.payload.producer.activationId);
      return;
    case OrchestrationEventType.DelegationResultSelected: {
      const key = `${owned.event.payload.cohortId}/${owned.event.payload.childWorkItemId}`;
      if (!facts.resultTimes.has(key))
        facts.resultTimes.set(key, Date.parse(owned.event.occurredAt));
      return;
    }
    default:
      return;
  }
}

/** Retries of one activation are separate Run attempts; the earliest start places the activation. */
function correctiveStarts(facts: DeliveryFacts): Map<string, number> {
  for (const run of facts.runs)
    if (facts.correctiveInstances.has(run.workflowInstanceId))
      facts.correctiveActivations.add(run.activationId);
  const firstStart = new Map<string, number>();
  for (const run of facts.runs) {
    if (!facts.correctiveActivations.has(run.activationId) || !Number.isFinite(run.startedAt))
      continue;
    const known = firstStart.get(run.activationId);
    if (known === undefined || run.startedAt < known)
      firstStart.set(run.activationId, run.startedAt);
  }
  return firstStart;
}

export async function queryDeliveryActivity(
  journal: EventJournal,
  query: ReportQuery,
  shared?: CompletionFacts,
) {
  const roots = shared ?? (await readCompletionFacts(journal, query));
  const facts: DeliveryFacts = {
    resultTimes: new Map(),
    correctiveInstances: new Set(),
    correctiveActivations: new Set(),
    runs: [],
  };
  for await (const event of scanJournal(journal, query.signal)) acceptDeliveryFact(facts, event);
  const firstStart = correctiveStarts(facts);
  const resultTimes = facts.resultTimes;

  const from = Date.parse(query.window.from),
    to = Date.parse(query.window.to);
  const first = Math.floor(from / query.window.bucketMs) * query.window.bucketMs;
  const buckets: { from: string; to: string; values: Record<string, number> }[] = [];
  for (let start = first; start < to; start += query.window.bucketMs)
    buckets.push({
      from: new Date(start).toISOString(),
      to: new Date(start + query.window.bucketMs).toISOString(),
      values: Object.fromEntries(series.map(({ id }) => [id, 0])),
    });
  const totals: Record<string, number> = Object.fromEntries(series.map(({ id }) => [id, 0]));
  let processed = 0;
  const add = (measure: string, at: number) => {
    if (!(at >= from && at < to)) return;
    totals[measure]!++;
    buckets[Math.floor((at - first) / query.window.bucketMs)]!.values[measure]!++;
  };
  for (const at of roots.completed.values()) {
    if (processed++ % 100 === 0) await yieldScan(query.signal);
    add(DeliveryActivityMeasure.RootDeliveries, at);
  }
  for (const at of resultTimes.values()) add(DeliveryActivityMeasure.AcceptedChildResults, at);
  for (const at of firstStart.values()) add(DeliveryActivityMeasure.CorrectiveActivations, at);
  const report: TimeSeriesReport = {
    report: descriptor,
    window: query.window,
    series,
    totals,
    buckets,
  };
  return report;
}

import { scanJournal, yieldScan, type EventEnvelope, type EventJournal } from '@atolis-hq/eventing';
import {
  defineClosedVocabulary,
  median,
  type ReportDefinition,
  type ReportQuery,
  type TimeSeriesReport,
} from '../../kernel/index.js';
import { selectWorkEvent, WorkEventType } from '../../work/index.js';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';

interface CompletionFacts {
  readonly created: Map<string, number>;
  readonly titles: Map<string, string>;
  readonly instances: Map<string, string>;
  readonly completed: Map<string, number>;
  /** Registered delegated descendants: their completion is a child result, not a delivered root. */
  readonly delegated: Set<string>;
}

export async function queryWorkCompletionSummary(journal: EventJournal, query: ReportQuery) {
  const facts = await readCompletionFacts(journal, query);
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
  if (work?.event.eventType === WorkEventType.ItemCreated) {
    facts.created.set(work.stream.id, Date.parse(work.event.occurredAt));
    facts.titles.set(work.stream.id, work.event.payload.objective);
    if (work.event.payload.delegation !== undefined) facts.delegated.add(work.stream.id);
  }
  const workflow = selectWorkflowOrchestrationEvent(event);
  if (workflow === null) return;
  switch (workflow.event.eventType) {
    case OrchestrationEventType.InstanceStarted:
      if (
        !('parentWorkflowInstanceId' in workflow.event.payload) &&
        !facts.delegated.has(workflow.event.payload.workItemId)
      )
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

export async function readCompletionFacts(journal: EventJournal, query: ReportQuery) {
  const facts: CompletionFacts = {
    created: new Map(),
    titles: new Map(),
    instances: new Map(),
    completed: new Map(),
    delegated: new Set(),
  };
  for await (const event of scanJournal(journal, query.signal)) acceptFact(facts, event);
  return facts;
}

export const WorkReportId = defineClosedVocabulary({ Throughput: 'work-item-throughput' } as const);

export const WorkReportMeasure = defineClosedVocabulary({ Completed: 'work-items-done' } as const);
const descriptor = { id: WorkReportId.Throughput, title: 'Work item throughput' };

export function createWorkThroughputReport(journal: EventJournal): ReportDefinition {
  return { ...descriptor, query: (query) => queryWorkThroughput(journal, query) };
}

export async function queryWorkThroughput(journal: EventJournal, query: ReportQuery) {
  const facts = await readCompletionFacts(journal, query);
  const from = Date.parse(query.window.from),
    to = Date.parse(query.window.to);
  const first = Math.floor(from / query.window.bucketMs) * query.window.bucketMs;
  const key = WorkReportMeasure.Completed;
  const buckets: { from: string; to: string; values: Record<string, number> }[] = [];
  for (let start = first; start < to; start += query.window.bucketMs)
    buckets.push({
      from: new Date(start).toISOString(),
      to: new Date(start + query.window.bucketMs).toISOString(),
      values: { [key]: 0 },
    });
  const rows: {
    id: string;
    title: string;
    createdAt: string;
    completedAt: string;
    durationMs: number;
  }[] = [];
  let total = 0,
    processed = 0;
  for (const [id, end] of facts.completed) {
    if (processed++ % 100 === 0) await yieldScan(query.signal);
    if (!(end >= from && end < to)) continue;
    total++;
    buckets[Math.floor((end - first) / query.window.bucketMs)]!.values[key]!++;
    const start = facts.created.get(id);
    if (start === undefined || !Number.isFinite(start) || end < start) continue;
    rows.push({
      id,
      title: facts.titles.get(id) ?? id,
      createdAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      durationMs: end - start,
    });
  }
  const sorted = await sortDurationRows(rows, query.signal);
  const report: TimeSeriesReport = {
    report: descriptor,
    window: query.window,
    series: [{ id: key, title: 'Work items done', unit: 'work items' }],
    totals: { [key]: total },
    buckets,
    durationRows: sorted,
    excludedDurationCount: total - rows.length,
  };
  return report;
}

type DurationRow = NonNullable<TimeSeriesReport['durationRows']>[number];

async function sortDurationRows(rows: DurationRow[], signal?: AbortSignal) {
  // Sort bounded batches and yield during merging to keep large reports cancellable.
  let sorted: typeof rows = [];
  const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id);
  for (let offset = 0; offset < rows.length; offset += 1024) {
    await yieldScan(signal);
    sorted.push(...rows.slice(offset, offset + 1024).sort(compare));
  }
  for (let width = 1024; width < sorted.length; width *= 2) {
    const merged: typeof rows = [];
    for (let start = 0; start < sorted.length; start += width * 2) {
      const middle = Math.min(start + width, sorted.length),
        end = Math.min(start + width * 2, sorted.length);
      let left = start,
        right = middle;
      while (left < middle || right < end) {
        if (merged.length % 1024 === 0) await yieldScan(signal);
        merged.push(
          right === end || (left < middle && compare(sorted[left]!, sorted[right]!) <= 0)
            ? sorted[left++]!
            : sorted[right++]!,
        );
      }
    }
    sorted = merged;
  }
  return sorted;
}

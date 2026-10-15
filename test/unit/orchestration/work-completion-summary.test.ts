import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { ReportWindowId, reportWindow } from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  WorkReportMeasure,
  queryWorkCompletionSummary,
  queryWorkThroughput,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../../src/orchestration/index.js';
import { WorkEventType, workItemStream } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

it('counts first primary completion per work item and measures creation through completion', async () => {
  const now = '2026-08-01T12:30:00.000Z';
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  const work = workItemStream(workId('completion'));
  const created = eventEnvelope(WorkEventType.ItemCreated, { objective: 'Test' }, work).event;
  await journal.appendToStream(work, 0, [{ ...created, occurredAt: '2026-07-30T12:00:00.000Z' }]);
  for (const id of ['workflow-1', 'workflow-2']) {
    const stream = workflowInstanceStream(workflowInstanceId(id));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: work.id,
          workflowName: 'delivery',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        stream,
      ).event,
    ]);
    const done = eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, stream).event;
    await journal.appendToStream(stream, 1, [{ ...done, occurredAt: '2026-08-01T12:00:00.000Z' }]);
  }
  expect(
    await queryWorkCompletionSummary(journal, { window: reportWindow(ReportWindowId.Day, now) }),
  ).toEqual({ workItemsDone: 1, medianEndToEndDurationMs: 172_800_000 });
  expect(
    await queryWorkCompletionSummary(journal, {
      window: reportWindow(ReportWindowId.FiveDays, now),
    }),
  ).toEqual({ workItemsDone: 0, medianEndToEndDurationMs: null });
  expect(
    (await queryWorkThroughput(journal, { window: reportWindow(ReportWindowId.Day, now) })).totals[
      WorkReportMeasure.Completed
    ],
  ).toBe(1);
});

it('excludes child completion and does not recount a primary first completed before the window', async () => {
  const now = '2026-08-01T12:30:00.000Z';
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  const workItemId = workId('completion-child');
  const child = workflowInstanceStream(workflowInstanceId('child-1'));
  await journal.appendToStream(child, 0, [
    eventEnvelope(
      OrchestrationEventType.InstanceStarted,
      {
        workItemId,
        workflowName: 'delivery',
        entry: 'implement',
        orchestrationGroupId: 'group-1',
        parentWorkflowInstanceId: 'parent-1',
        watchId: 'watch-1',
        triggerId: 'trigger-1',
        causalCycleId: 'cycle-1',
        requestId: 'request-1',
        childWorkflowInstanceId: child.id,
      },
      child,
    ).event,
    eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, child).event,
  ]);
  const primary = workflowInstanceStream(workflowInstanceId('primary-1'));
  const completed = eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, primary).event;
  await journal.appendToStream(primary, 0, [
    eventEnvelope(
      OrchestrationEventType.InstanceStarted,
      { workItemId, workflowName: 'delivery', entry: 'implement', orchestrationGroupId: 'group-1' },
      primary,
    ).event,
    { ...completed, occurredAt: '2026-07-30T12:00:00.000Z' },
    completed,
  ]);
  expect(
    await queryWorkCompletionSummary(journal, { window: reportWindow(ReportWindowId.Day, now) }),
  ).toEqual({ workItemsDone: 0, medianEndToEndDurationMs: null });
  expect(
    (await queryWorkThroughput(journal, { window: reportWindow(ReportWindowId.Day, now) })).totals[
      WorkReportMeasure.Completed
    ],
  ).toBe(0);
});

it('reconciles throughput counts and buckets while excluding invalid duration rows and ordering newest first', async () => {
  const now = '2026-08-01T12:30:00.000Z';
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  const window = reportWindow(ReportWindowId.Day, now);
  const cases = [
    ['older', '2026-07-30T12:00:00.000Z', '2026-08-01T10:00:00.000Z'],
    ['newer', '2026-08-01T11:00:00.000Z', '2026-08-01T12:00:00.000Z'],
    ['reversed', '2026-08-02T00:00:00.000Z', '2026-08-01T12:00:00.000Z'],
    ['missing', undefined, '2026-08-01T12:00:00.000Z'],
    ['boundary-from', '2026-07-30T00:00:00.000Z', window.from],
    ['boundary-to', '2026-07-30T00:00:00.000Z', window.to],
  ] as const;
  for (const [id, createdAt, completedAt] of cases) {
    const work = workItemStream(workId(id));
    if (createdAt !== undefined)
      await journal.appendToStream(work, 0, [
        {
          ...eventEnvelope(WorkEventType.ItemCreated, { objective: id }, work).event,
          occurredAt: createdAt,
        },
      ]);
    const stream = workflowInstanceStream(workflowInstanceId(id));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: work.id,
          workflowName: 'delivery',
          entry: 'implement',
          orchestrationGroupId: 'group-1',
        },
        stream,
      ).event,
      {
        ...eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, stream).event,
        occurredAt: completedAt,
      },
      {
        ...eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, stream).event,
        occurredAt: now,
      },
    ]);
  }
  const report = await queryWorkThroughput(journal, { window });
  const summary = await queryWorkCompletionSummary(journal, { window });
  expect(report.totals[WorkReportMeasure.Completed]).toBe(5);
  expect(report.totals[WorkReportMeasure.Completed]).toBe(summary.workItemsDone);
  expect(
    report.buckets.reduce((sum, bucket) => sum + bucket.values[WorkReportMeasure.Completed]!, 0),
  ).toBe(summary.workItemsDone);
  expect(report.excludedDurationCount).toBe(2);
  expect(report.durationRows?.map((row) => row.title)).toEqual(['newer', 'older', 'boundary-from']);
  expect(report.durationRows?.[0]).toMatchObject({
    durationMs: 3_600_000,
    createdAt: '2026-08-01T11:00:00.000Z',
    completedAt: '2026-08-01T12:00:00.000Z',
  });
  const empty = await queryWorkThroughput(journal, {
    window: reportWindow(ReportWindowId.Week, '2026-09-01T00:00:00.000Z'),
  });
  expect(empty.durationRows).toEqual([]);
  expect(empty.excludedDurationCount).toBe(0);
  expect(empty.totals[WorkReportMeasure.Completed]).toBe(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    queryWorkThroughput(journal, { window, signal: controller.signal }),
  ).rejects.toThrow();
});

it('rejects malformed persisted timestamps through the owning decoder', async () => {
  const journal = new InMemoryEventJournal({ now: () => new Date('2026-08-01T12:30:00.000Z') });
  const stream = workItemStream(workId('malformed'));
  await journal.appendToStream(stream, 0, [
    {
      ...eventEnvelope(WorkEventType.ItemCreated, { objective: 'Malformed timestamp' }, stream)
        .event,
      occurredAt: 'invalid',
    },
  ]);
  await expect(
    queryWorkThroughput(journal, {
      window: reportWindow(ReportWindowId.Day, '2026-08-01T12:30:00.000Z'),
    }),
  ).rejects.toThrow('Invalid Work event');
});

it('merges large duration batches in newest-first order', async () => {
  const now = '2026-08-01T12:30:00.000Z';
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  for (let index = 0; index < 2050; index++) {
    const work = workItemStream(workId(`batch-${index}`));
    const stream = workflowInstanceStream(workflowInstanceId(`batch-${index}`));
    await journal.appendToStream(work, 0, [
      {
        ...eventEnvelope(WorkEventType.ItemCreated, { objective: String(index) }, work).event,
        occurredAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: work.id,
          workflowName: 'delivery',
          entry: 'implement',
          orchestrationGroupId: 'group-1',
        },
        stream,
      ).event,
      {
        ...eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, stream).event,
        occurredAt: new Date(Date.parse(now) - (index + 1) * 1000).toISOString(),
      },
    ]);
  }
  const report = await queryWorkThroughput(journal, {
    window: reportWindow(ReportWindowId.Day, now),
  });
  expect(report.durationRows?.map((row) => row.title)).toEqual(
    Array.from({ length: 2050 }, (_, index) => String(index)),
  );
});

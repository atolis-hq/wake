import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { ReportWindowId, reportWindow } from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  queryWorkCompletionSummary,
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
});

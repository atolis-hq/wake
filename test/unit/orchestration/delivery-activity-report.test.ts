import type { createEventData } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { ExecutionEventType, runId, runStream } from '../../../src/execution/index.js';
import { ReportWindowId, reportWindow } from '../../../src/kernel/index.js';
import {
  DeliveryActivityMeasure,
  OrchestrationEventType,
  queryDeliveryActivity,
  queryWorkCompletionSummary,
  queryWorkThroughput,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../../src/orchestration/index.js';
import { WorkEventType, workItemStream } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

const now = '2026-08-01T12:30:00.000Z';
const revision = 'a'.repeat(40);
const other = 'b'.repeat(40);

function at<Event extends { occurredAt: string }>(event: Event, occurredAt: string): Event {
  return { ...event, occurredAt };
}

async function append(
  journal: InMemoryEventJournal,
  stream: Parameters<InMemoryEventJournal['appendToStream']>[0],
  event: ReturnType<typeof createEventData>,
) {
  await journal.appendToStream(stream, (await journal.readStream(stream)).length, [event]);
}

const child = (workItem: string, instance: string, extra: object = {}) => ({
  assignmentId: workItem,
  objective: workItem,
  criteria: ['works'],
  workflowName: 'delivery',
  workflowFingerprint: 'fp',
  context: [],
  outputs: [{ name: 'plan', path: 'plan.md' }],
  workItemId: workId(workItem),
  workflowInstanceId: workflowInstanceId(instance),
  grantId: 'grant',
  ...extra,
});

async function scenario() {
  const journal = new InMemoryEventJournal({ now: () => new Date(now) });
  const parentStream = workflowInstanceStream(workflowInstanceId('parent'));
  const rootWork = workItemStream(workId('root'));
  const childWork = workItemStream(workId('child'));
  await append(
    journal,
    rootWork,
    at(
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Root' }, rootWork).event,
      '2026-07-31T13:00:00.000Z',
    ),
  );
  await append(
    journal,
    childWork,
    eventEnvelope(
      WorkEventType.ItemCreated,
      {
        objective: 'Child',
        delegation: {
          parentWorkItemId: workId('root'),
          rootWorkItemId: workId('root'),
          ancestors: [workId('root')],
        },
      },
      childWork,
    ).event,
  );
  await append(
    journal,
    parentStream,
    eventEnvelope(
      OrchestrationEventType.DelegationReserved,
      {
        cohortId: 'cohort-1',
        parentWorkflowInstanceId: workflowInstanceId('parent'),
        parentWorkItemId: workId('root'),
        rootWorkItemId: workId('root'),
        activationId: 'parent:activity:1',
        runId: 'parent-run',
        ancestors: [],
        maxDepth: 1,
        maxDescendants: 8,
        children: [
          child('child', 'child-instance'),
          child('fixer', 'fixer-instance', {
            replaces: { cohortId: 'cohort-1', assignmentId: 'child' },
          }),
        ],
      },
      parentStream,
    ).event,
  );
  for (const [id, workItem] of [
    ['root-instance', 'root'],
    ['child-instance', 'child'],
  ] as const) {
    const stream = workflowInstanceStream(workflowInstanceId(id));
    await append(
      journal,
      stream,
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: workId(workItem),
          workflowName: 'delivery',
          orchestrationGroupId: 'group-1',
          entry: 'implement',
        },
        stream,
      ).event,
    );
    await append(
      journal,
      stream,
      at(
        eventEnvelope(OrchestrationEventType.InstanceCompleted, {}, stream).event,
        '2026-08-01T12:00:00.000Z',
      ),
    );
  }
  // A replayed selection of the same result is one durable identity.
  for (let duplicate = 0; duplicate < 2; duplicate++) {
    await append(
      journal,
      parentStream,
      at(
        eventEnvelope(
          OrchestrationEventType.DelegationResultSelected,
          { cohortId: 'cohort-1', childWorkItemId: workId('child'), outputs: [] },
          parentStream,
        ).event,
        '2026-08-01T11:00:00.000Z',
      ),
    );
  }
  return { journal, parentStream };
}

async function run(
  journal: InMemoryEventJournal,
  id: string,
  activation: string,
  instance: string,
  startedAt: string,
) {
  const stream = runStream(runId(id));
  await append(
    journal,
    stream,
    eventEnvelope(
      ExecutionEventType.RunPreparationStarted,
      {
        activationId: activation,
        activity: 'agent',
        workflowInstanceId: instance,
        orchestrationGroupId: 'group-1',
        attempt: 1,
        startedAt,
      },
      stream,
    ).event,
  );
}

const day = { window: reportWindow(ReportWindowId.Day, now) };

it('counts roots, accepted child results and corrective activations as separate populations (DC-25)', async () => {
  const { journal } = await scenario();
  // Two Runs of one corrective activation (retry) plus a non-corrective Run on the original child.
  await run(journal, 'run-a', 'fixer:activity:1', 'fixer-instance', '2026-08-01T10:00:00.000Z');
  await run(journal, 'run-b', 'fixer:activity:1', 'fixer-instance', '2026-08-01T10:30:00.000Z');
  await run(journal, 'run-c', 'child:activity:1', 'child-instance', '2026-08-01T10:00:00.000Z');

  const report = await queryDeliveryActivity(journal, day);
  expect(report.totals).toEqual({
    [DeliveryActivityMeasure.RootDeliveries]: 1,
    [DeliveryActivityMeasure.AcceptedChildResults]: 1,
    [DeliveryActivityMeasure.CorrectiveActivations]: 1,
  });
  const bucket = report.buckets.find((entry) => entry.from === '2026-08-01T10:00:00.000Z')!;
  expect(bucket.values[DeliveryActivityMeasure.CorrectiveActivations]).toBe(1);
  // The same journal always yields the same report (rebuild/restart).
  expect(await queryDeliveryActivity(journal, day)).toEqual(report);
});

it('places a corrective activation by its first Run start, with half-open window edges', async () => {
  const { journal } = await scenario();
  await run(journal, 'late', 'fixer:activity:1', 'fixer-instance', '2026-08-01T12:00:00.000Z');
  await run(journal, 'early', 'fixer:activity:1', 'fixer-instance', '2026-07-31T12:30:00.000Z');
  const total = (report: Awaited<ReturnType<typeof queryDeliveryActivity>>) =>
    report.totals[DeliveryActivityMeasure.CorrectiveActivations];
  // The first start equals the window start, which is inside `[from, to)`.
  expect(total(await queryDeliveryActivity(journal, day))).toBe(1);
  // A window that begins after that first start excludes it even though a later Run is inside.
  const later = { window: reportWindow(ReportWindowId.Day, '2026-08-01T13:00:00.000Z') };
  expect(total(await queryDeliveryActivity(journal, later))).toBe(0);
});

it('does not count activations that never started a Run or lack provenance', async () => {
  const { journal } = await scenario();
  await run(journal, 'plain', 'child:activity:1', 'child-instance', '2026-08-01T10:00:00.000Z');
  expect(
    (await queryDeliveryActivity(journal, day)).totals[
      DeliveryActivityMeasure.CorrectiveActivations
    ],
  ).toBe(0);
});

it('does not count a delegated child completion as a delivered root', async () => {
  const { journal } = await scenario();
  expect(await queryWorkCompletionSummary(journal, day)).toMatchObject({ workItemsDone: 1 });
  const throughput = await queryWorkThroughput(journal, day);
  expect(throughput.durationRows?.map((row) => row.id)).toEqual([workId('root')]);
});

it('counts a maintenance producer activation once, from its own recorded provenance', async () => {
  const { journal, parentStream } = await scenario();
  const subject = { revision, pullRequestBase: 'main' };
  await append(
    journal,
    parentStream,
    eventEnvelope(
      OrchestrationEventType.DeliveryMaintenanceRecorded,
      {
        maintenanceId: 'rebase-1',
        target: { childWorkItemId: workId('child'), outputName: 'change' },
        kind: 'rebase',
        resourceId: 'pr-1',
        repositoryResourceId: 'repo-1',
        previous: subject,
        current: { ...subject, revision: other },
        producer: { runId: 'maintain-run', activationId: 'parent:activity:9' },
      },
      parentStream,
    ).event,
  );
  await run(journal, 'm-1', 'parent:activity:9', 'parent', '2026-08-01T09:00:00.000Z');
  await run(journal, 'm-2', 'parent:activity:9', 'parent', '2026-08-01T09:05:00.000Z');
  const report = await queryDeliveryActivity(journal, day);
  expect(report.totals[DeliveryActivityMeasure.CorrectiveActivations]).toBe(1);
  expect(report.totals[DeliveryActivityMeasure.RootDeliveries]).toBe(1);
});

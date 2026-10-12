import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { ActivityOutcomeKind } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  queryRunAnalytics,
  runId,
  RunReportOutcome,
  runStream,
} from '../../../src/execution/index.js';
import { reportWindow, ReportWindowId } from '../../../src/kernel/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';

const now = '2026-08-01T12:30:00.000Z';
const clock = { now: () => new Date(now) };
const query = { window: reportWindow(ReportWindowId.Day, now) };

describe('live run analytics', () => {
  it('uses rolling aligned boundary buckets and preceding complete UTC days', () => {
    expect(query.window).toMatchObject({
      from: '2026-07-31T12:30:00.000Z',
      to: now,
      bucketMs: 3_600_000,
    });
    expect(reportWindow(ReportWindowId.ThreeDays, now)).toMatchObject({
      from: '2026-07-29T12:30:00.000Z',
      bucketMs: 21_600_000,
    });
    expect(reportWindow(ReportWindowId.FiveDays, now)).toMatchObject({
      from: '2026-07-27T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      bucketMs: 86_400_000,
    });
    expect(reportWindow(ReportWindowId.Week, now).from).toBe('2026-07-25T00:00:00.000Z');
  });

  it('returns zero buckets and empty medians without any runs', async () => {
    const result = await queryRunAnalytics(new InMemoryEventJournal(clock), query);
    expect(result.report.buckets).toHaveLength(25);
    expect(
      result.report.buckets.every((bucket) =>
        Object.values(bucket.values).every((count) => count === 0),
      ),
    ).toBe(true);
    expect(result.summary).toEqual({
      runs: 0,
      completed: 0,
      blockedOrAwaitingApproval: 0,
      failed: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      medianRunDurationMs: null,
    });
  });

  it('keeps the start cohort, maps every outcome, and includes preparation and partial usage', async () => {
    const journal = new InMemoryEventJournal(clock);
    const kinds = [
      ActivityOutcomeKind.Done,
      ActivityOutcomeKind.Blocked,
      ActivityOutcomeKind.Waiting,
      ActivityOutcomeKind.Failed,
      ActivityOutcomeKind.Rejected,
      'custom',
    ];
    for (const [index, kind] of kinds.entries()) {
      const stream = runStream(runId(`run-${index}`));
      const start = '2026-07-31T12:30:00.000Z';
      await journal.appendToStream(stream, 0, [
        eventEnvelope(
          ExecutionEventType.RunPreparationStarted,
          {
            activationId: `activation-${index}`,
            activity: 'agent',
            workflowInstanceId: 'workflow-1',
            orchestrationGroupId: 'group-1',
            attempt: 1,
            startedAt: start,
          },
          stream,
        ).event,
      ]);
      await journal.appendToStream(stream, 1, [
        eventEnvelope(
          ExecutionEventType.RunRunnerResultReported,
          {
            transport: 'succeeded',
            agent: {
              outcome: 'DONE',
              displayBody: '',
              metadata: { inputTokens: 10, costUsd: 0.25 },
            },
          },
          stream,
        ).event,
      ]);
      await journal.appendToStream(stream, 2, [
        eventEnvelope(
          ExecutionEventType.RunSucceeded,
          { finishedAt: '2026-08-01T13:30:00.000Z', outcome: { kind } },
          stream,
        ).event,
      ]);
    }
    for (const [index, start] of [
      '2026-07-31T12:29:59.999Z',
      now,
      '2026-07-31T13:00:00.000Z',
    ].entries()) {
      const stream = runStream(runId(`run-active-${index}`));
      await journal.appendToStream(stream, 0, [
        eventEnvelope(
          ExecutionEventType.RunStarted,
          {
            activationId: `active-${index}`,
            activity: 'agent',
            workflowInstanceId: 'workflow-1',
            orchestrationGroupId: 'group-1',
            attempt: 1,
            startedAt: start,
          },
          stream,
        ).event,
      ]);
    }
    const result = await queryRunAnalytics(journal, query);
    expect(result.summary).toEqual({
      runs: 7,
      completed: 1,
      blockedOrAwaitingApproval: 2,
      failed: 2,
      totalTokens: 60,
      totalCostUsd: 1.5,
      medianRunDurationMs: 90_000_000,
    });
    expect(result.report.totals).toEqual({
      completed: 1,
      blocked: 1,
      'awaiting-approval': 1,
      failed: 2,
      other: 2,
    });
    expect(result.report.buckets[0]?.values[RunReportOutcome.Completed]).toBe(1);
    expect(result.report.buckets[1]?.values[RunReportOutcome.Other]).toBe(1);
  });
});

it('keeps cancelled and ambiguous runs in other while execution failures count as failed', async () => {
  const journal = new InMemoryEventJournal(clock);
  for (const [index, terminal] of [
    ExecutionEventType.RunCancelled,
    ExecutionEventType.RunAmbiguous,
    ExecutionEventType.RunFailed,
  ].entries()) {
    const stream = runStream(runId(`run-terminal-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `terminal-${index}`,
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt: '2026-08-01T12:00:00.000Z',
        },
        stream,
      ).event,
    ]);
    const payload =
      terminal === ExecutionEventType.RunFailed
        ? { finishedAt: now, failure: { kind: 'unexpected-execution-failure', message: 'Failed' } }
        : terminal === ExecutionEventType.RunAmbiguous
          ? { finishedAt: now, reason: 'Unknown' }
          : { finishedAt: now };
    await journal.appendToStream(stream, 1, [eventEnvelope(terminal, payload, stream).event]);
  }
  const result = await queryRunAnalytics(journal, query);
  expect(result.report.totals).toMatchObject({ other: 2, failed: 1 });
  expect(result.summary.medianRunDurationMs).toBe(1_800_000);
});

it('groups all four dimensions across the window with deterministic counts and shares', async () => {
  const journal = new InMemoryEventJournal(clock);
  for (const [index, startedAt] of [
    query.window.from,
    '2026-08-01T12:00:00.000Z',
    '2026-08-01T11:00:00.000Z',
    now,
    '2026-07-31T12:29:59.999Z',
  ].entries()) {
    const stream = runStream(runId(`breakdown-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `activation-${index}`,
          activity: index === 0 ? 'zeta' : 'alpha',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt,
          ...(index === 0
            ? {}
            : { stage: 'implement', runner: { name: 'codex', model: 'model-a' } }),
        },
        stream,
      ).event,
    ]);
  }
  const { breakdown, summary } = await queryRunAnalytics(journal, query);
  expect(breakdown.total).toBe(summary.runs);
  expect(breakdown.total).toBe(3);
  expect(breakdown.dimensions.map(({ id }) => id)).toEqual([
    'run-action',
    'run-stage',
    'run-runner',
    'run-model',
  ]);
  expect(breakdown.dimensions[0]?.rows).toEqual([
    { value: 'alpha', count: 2, share: 2 / 3 },
    { value: 'zeta', count: 1, share: 1 / 3 },
  ]);
  for (const dimension of breakdown.dimensions) {
    expect(dimension.rows.reduce((sum, row) => sum + row.count, 0)).toBe(summary.runs);
  }
  for (const dimension of breakdown.dimensions.slice(1)) {
    expect(dimension.rows[1]).toEqual({ value: 'unknown', count: 1, share: 1 / 3 });
  }
});

it('returns empty breakdown rows and respects cancellation', async () => {
  const journal = new InMemoryEventJournal(clock);
  const { breakdown } = await queryRunAnalytics(journal, query);
  expect(breakdown.total).toBe(0);
  expect(breakdown.dimensions.every(({ rows }) => rows.length === 0)).toBe(true);
  const controller = new AbortController();
  controller.abort();
  await expect(
    queryRunAnalytics(journal, { ...query, signal: controller.signal }),
  ).rejects.toThrow();
});

it('orders ties alphabetically and preserves distinct recorded and unknown values', async () => {
  const journal = new InMemoryEventJournal(clock);
  for (const [index, stage] of ['zeta', 'alpha', 'Alpha', 'unknown', undefined].entries()) {
    const stream = runStream(runId(`tie-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `tie-${index}`,
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt: query.window.from,
          ...(stage === undefined ? {} : { stage }),
        },
        stream,
      ).event,
    ]);
  }
  const { breakdown } = await queryRunAnalytics(journal, query);
  expect(breakdown.dimensions[1]?.rows).toEqual([
    { value: 'unknown', count: 2, share: 0.4 },
    { value: 'Alpha', count: 1, share: 0.2 },
    { value: 'alpha', count: 1, share: 0.2 },
    { value: 'zeta', count: 1, share: 0.2 },
  ]);
});

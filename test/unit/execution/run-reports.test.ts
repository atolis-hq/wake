import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import { ActivityOutcomeKind } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  queryRunAnalytics,
  runId,
  RunReportOutcome,
  runStream,
  RunUsageMeasure,
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
    for (const [measure, total] of [
      [RunUsageMeasure.Tokens, result.summary.totalTokens],
      [RunUsageMeasure.CostUsd, result.summary.totalCostUsd],
    ] as const) {
      expect(result.usage.totals[measure]).toBe(total);
      expect(result.usage.buckets.reduce((sum, bucket) => sum + bucket.values[measure]!, 0)).toBe(
        total,
      );
    }
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
              metadata: {
                inputTokens: 10,
                outputTokens: 2,
                cacheWriteTokens: 3,
                cacheReadTokens: 5,
                costUsd: 0.25,
              },
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
      totalTokens: 120,
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

it('groups all six dimensions across the window with deterministic counts and shares', async () => {
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
    'run-repository',
    'run-runner-pool',
  ]);
  expect(breakdown.dimensions[0]?.rows).toEqual([
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'alpha',
      count: 2,
      share: 2 / 3,
    },
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'zeta',
      count: 1,
      share: 1 / 3,
    },
  ]);
  for (const dimension of breakdown.dimensions) {
    expect(dimension.rows.reduce((sum, row) => sum + row.count, 0)).toBe(summary.runs);
  }
  for (const dimension of breakdown.dimensions.slice(4)) {
    expect(dimension.rows).toEqual([
      {
        tokens: 0,
        costUsd: 0,
        durationMs: 0,
        tokenRuns: 0,
        costRuns: 0,
        durationRuns: 0,
        value: 'unknown',
        count: 3,
        share: 1,
      },
    ]);
  }
  for (const dimension of breakdown.dimensions.slice(1, 4)) {
    expect(dimension.rows[1]).toEqual({
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'unknown',
      count: 1,
      share: 1 / 3,
    });
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
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'unknown',
      count: 2,
      share: 0.4,
    },
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'Alpha',
      count: 1,
      share: 0.2,
    },
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'alpha',
      count: 1,
      share: 0.2,
    },
    {
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
      value: 'zeta',
      count: 1,
      share: 0.2,
    },
  ]);
});

it('reconciles non-zero usage across buckets, excluding both window boundaries outside the cohort', async () => {
  const journal = new InMemoryEventJournal(clock);
  const starts = [
    query.window.from,
    '2026-07-31T13:15:00.000Z',
    '2026-07-31T14:00:00.000Z',
    '2026-07-31T12:29:59.999Z',
    query.window.to,
  ];
  const metadata = [
    { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.1 },
    { outputTokens: 5, costUsd: 0.2 },
    undefined,
    { inputTokens: 9999, costUsd: 99 },
    { inputTokens: 9999, costUsd: 99 },
  ];
  for (const [index, startedAt] of starts.entries()) {
    const stream = runStream(runId(`usage-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `usage-${index}`,
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt,
        },
        stream,
      ).event,
    ]);
    if (metadata[index] !== undefined) {
      await journal.appendToStream(stream, 1, [
        eventEnvelope(
          ExecutionEventType.RunRunnerResultReported,
          {
            transport: 'succeeded',
            agent: { outcome: 'DONE', displayBody: '', metadata: metadata[index] },
          },
          stream,
        ).event,
      ]);
    }
  }
  const { usage, summary } = await queryRunAnalytics(journal, query);
  expect(summary.runs).toBe(3);
  expect(usage.totals).toEqual({
    [RunUsageMeasure.Tokens]: summary.totalTokens,
    [RunUsageMeasure.CostUsd]: summary.totalCostUsd,
  });
  expect(summary.totalTokens).toBe(1032);
  expect(summary.totalCostUsd).toBeCloseTo(0.3);
  expect(usage.buckets[0]?.values).toEqual({
    [RunUsageMeasure.Tokens]: 1027,
    [RunUsageMeasure.CostUsd]: 0.1,
  });
  expect(usage.buckets[1]?.values).toEqual({
    [RunUsageMeasure.Tokens]: 5,
    [RunUsageMeasure.CostUsd]: 0.2,
  });
  expect(
    usage.buckets
      .slice(2)
      .every(({ values }) => Object.values(values).every((value) => value === 0)),
  ).toBe(true);
  for (const measure of Object.values(RunUsageMeasure)) {
    expect(usage.buckets.reduce((sum, bucket) => sum + bucket.values[measure]!, 0)).toBe(
      usage.totals[measure],
    );
  }
});

it('computes exact duration statistics, groups and start buckets with invalid durations excluded', async () => {
  const journal = new InMemoryEventJournal(clock);
  for (const [index, duration] of [0, 2000, 7000, 11000, -1, null].entries()) {
    const stream = runStream(runId(`duration-${index}`));
    const startedAt = query.window.from;
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `duration-${index}`,
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt,
          ...(index === 2 ? { stage: 'review' } : {}),
        },
        stream,
      ).event,
    ]);
    if (duration !== null)
      await journal.appendToStream(stream, 1, [
        eventEnvelope(
          ExecutionEventType.RunSucceeded,
          {
            finishedAt: new Date(Date.parse(startedAt) + duration).toISOString(),
            outcome: { kind: ActivityOutcomeKind.Done },
          },
          stream,
        ).event,
      ]);
  }
  const { duration, summary } = await queryRunAnalytics(journal, query);
  expect(duration.statistics).toEqual({ count: 4, medianMs: 4500, averageMs: 5000 });
  expect(duration.statistics.medianMs).toBe(summary.medianRunDurationMs);
  expect(duration.groups[0]?.rows).toEqual([{ value: 'agent', ...duration.statistics }]);
  expect(duration.groups[1]?.rows).toEqual([
    { value: 'unknown', count: 3, medianMs: 2000, averageMs: 13000 / 3 },
    { value: 'review', count: 1, medianMs: 7000, averageMs: 7000 },
  ]);
  expect(duration.buckets[0]).toMatchObject(duration.statistics);
  expect(
    duration.buckets
      .slice(1)
      .every(
        (bucket) => bucket.count === 0 && bucket.medianMs === null && bucket.averageMs === null,
      ),
  ).toBe(true);
  const empty = await queryRunAnalytics(new InMemoryEventJournal(clock), query);
  expect(empty.duration.statistics).toEqual({ count: 0, medianMs: null, averageMs: null });
});

it('buckets duration by start with half-open window boundaries', async () => {
  const journal = new InMemoryEventJournal(clock);
  const starts = [
    query.window.from,
    '2026-07-31T13:00:00.000Z',
    query.window.to,
    '2026-07-31T12:29:59.999Z',
  ];
  for (const [index, startedAt] of starts.entries()) {
    const stream = runStream(runId(`duration-boundary-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `boundary-${index}`,
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt,
        },
        stream,
      ).event,
    ]);
    await journal.appendToStream(stream, 1, [
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        {
          finishedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
          outcome: { kind: ActivityOutcomeKind.Done },
        },
        stream,
      ).event,
    ]);
  }
  const { duration } = await queryRunAnalytics(journal, query);
  expect(duration.statistics).toEqual({ count: 2, medianMs: 1000, averageMs: 1000 });
  expect(duration.buckets.slice(0, 2).map((bucket) => bucket.count)).toEqual([1, 1]);
  expect(duration.buckets.slice(2).every((bucket) => bucket.count === 0)).toBe(true);
});

it('aggregates independent usage samples including zeros and excludes absent or malformed values', async () => {
  const journal = new InMemoryEventJournal(clock);
  const usages = [
    { inputTokens: 10, costUsd: 0.5 },
    { outputTokens: 0 },
    { costUsd: 0 },
    { inputTokens: 'bad', costUsd: null },
    undefined,
  ];
  for (const [index, metadata] of usages.entries()) {
    const stream = runStream(runId(`samples-${index}`));
    await journal.appendToStream(stream, 0, [
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: `samples-${index}`,
          activity: index === 4 ? 'empty' : 'agent',
          workflowInstanceId: 'workflow-1',
          orchestrationGroupId: 'group-1',
          attempt: 1,
          startedAt: query.window.from,
        },
        stream,
      ).event,
    ]);
    if (metadata !== undefined)
      await journal.appendToStream(stream, 1, [
        eventEnvelope(
          ExecutionEventType.RunRunnerResultReported,
          {
            transport: 'succeeded',
            agent: { outcome: 'DONE', displayBody: '', metadata },
          },
          stream,
        ).event,
      ]);
    if (index < 3)
      await journal.appendToStream(stream, 2, [
        eventEnvelope(
          ExecutionEventType.RunSucceeded,
          {
            finishedAt: new Date(
              Date.parse(query.window.from) + [2000, 0, -1][index]!,
            ).toISOString(),
            outcome: { kind: ActivityOutcomeKind.Done },
          },
          stream,
        ).event,
      ]);
  }
  const { breakdown, summary } = await queryRunAnalytics(journal, query);
  expect(breakdown.dimensions[0]?.rows).toEqual([
    {
      value: 'agent',
      count: 4,
      share: 0.8,
      tokens: 10,
      costUsd: 0.5,
      durationMs: 2000,
      tokenRuns: 2,
      costRuns: 2,
      durationRuns: 2,
    },
    {
      value: 'empty',
      count: 1,
      share: 0.2,
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      tokenRuns: 0,
      costRuns: 0,
      durationRuns: 0,
    },
  ]);
  for (const { rows } of breakdown.dimensions) {
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(summary.totalTokens);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBe(summary.totalCostUsd);
    expect(rows.reduce((sum, row) => sum + row.durationMs, 0)).toBe(2000);
  }
});

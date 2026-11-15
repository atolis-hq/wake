import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { resolveResourceRepositoryIdentity } from '../../../src/bootstrap/composition-root.js';
import { boardProjection } from '../../../src/bootstrap/index.js';
import { createSurfaceApiApplications } from '../../../src/bootstrap/surface-api-applications.js';
import { RunStatus } from '../../../src/execution/index.js';
import { WorkEventType, workItemStream } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

it('normalizes a retired keyed active-run phase during an immediate board API read', async () => {
  const item = workId('board-api-concurrent-runs');
  const legacyPhase = 'running' as const;
  const root = rootWithBoard({
    cards: {
      [item]: {
        workItemKey: 'wk_board_api_concurrent_runs',
        workItemId: item,
        objective: 'Present concurrent activity',
        condition: 'active',
        dwellSince: '2026-08-03T12:00:00.000Z',
        runCount: 2,
        activeRuns: {
          'run-first': {
            action: 'implement',
            runnerName: 'claude',
            startedAt: '2026-08-03T12:00:00.000Z',
            phase: RunStatus.Starting,
          },
          'run-second': {
            action: 'review',
            runnerName: 'codex',
            startedAt: '2026-08-03T12:03:00.000Z',
            phase: legacyPhase,
          },
        },
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
    },
    workflows: {},
    runs: {},
    children: {},
    childRuns: {},
  } as unknown as ReturnType<typeof boardProjection.initial>);

  const result = await createSurfaceApiApplications(
    root,
    () => '2026-08-03T12:05:00.000Z',
  ).board!.list({ limit: 10 });

  expect(result.items[0]?.activeRuns).toEqual({
    'run-first': {
      action: 'implement',
      runnerName: 'claude',
      startedAt: '2026-08-03T12:00:00.000Z',
      elapsedMs: 300_000,
      phase: RunStatus.Starting,
    },
    'run-second': {
      action: 'review',
      runnerName: 'codex',
      startedAt: '2026-08-03T12:03:00.000Z',
      elapsedMs: 120_000,
      phase: RunStatus.Started,
    },
  });
});

it('normalizes a retired single active-run phase during an immediate board API read', async () => {
  const item = workId('board-api-legacy-active-run');
  const legacyPhase = 'running' as const;
  const root = rootWithBoard({
    cards: {
      [item]: {
        workItemKey: 'wk_board_api_legacy_active_run',
        workItemId: item,
        objective: 'Keep a legacy run visible',
        condition: 'active',
        dwellSince: '2026-08-03T12:00:00.000Z',
        runCount: 1,
        activeRun: {
          action: 'implement',
          runnerName: 'claude',
          startedAt: '2026-08-03T12:00:00.000Z',
          phase: legacyPhase,
        },
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
    },
    workflows: {},
    runs: { 'run-legacy': item },
    children: {},
    childRuns: {},
  } as unknown as ReturnType<typeof boardProjection.initial>);

  const result = await createSurfaceApiApplications(
    root,
    () => '2026-08-03T12:05:00.000Z',
  ).board!.list({ limit: 10 });

  expect(result.items[0]?.activeRuns).toEqual({
    'run-legacy': {
      action: 'implement',
      runnerName: 'claude',
      startedAt: '2026-08-03T12:00:00.000Z',
      elapsedMs: 300_000,
      phase: RunStatus.Started,
    },
  });
});

it('exposes the repository on board cards only when the adapter resolves one', async () => {
  const github = workId('board-api-repo-github');
  const other = workId('board-api-repo-other');
  const card = (id: string, key: string) => ({
    workItemKey: key,
    workItemId: id,
    objective: key,
    condition: 'ready',
    dwellSince: '2026-08-03T12:00:00.000Z',
    runCount: 0,
    activeRuns: {},
    totalTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
  });
  const root = rootWithBoard({
    cards: { [github]: card(github, 'wk_github'), [other]: card(other, 'wk_other') },
    workflows: {},
    runs: {},
    children: {},
    childRuns: {},
  } as unknown as ReturnType<typeof boardProjection.initial>);
  const keys: Record<string, { adapter: string; key: string }> = {
    [github]: { adapter: 'github', key: 'atolis-hq/wake#12' },
    [other]: { adapter: 'fake', key: 'org/a#2' },
  };
  Object.assign(root, {
    resolveResourceRepositoryIdentity,
    resources: {
      correlationsForWork: async (id: string) => [{ role: 'primary', resourceId: `res-${id}` }],
      get: async (resourceId: string) => ({
        resourceId,
        externalKey: keys[resourceId.slice('res-'.length)],
      }),
    },
  });

  const result = await createSurfaceApiApplications(
    root,
    () => '2026-08-03T12:05:00.000Z',
  ).board!.list({ limit: 10 });
  const byKey = new Map(result.items.map((item) => [item.workItemKey, item]));

  expect(byKey.get('wk_github')?.repository).toBe('atolis-hq/wake');
  expect(byKey.get('wk_other')).not.toHaveProperty('repository');
});

function rootWithBoard(view: ReturnType<typeof boardProjection.initial>): CompositionRoot {
  const event = eventEnvelope(
    WorkEventType.ItemCreated,
    { objective: 'Present concurrent activity' },
    workItemStream(workId('board-api-concurrent-runs')),
    1,
  );
  return {
    projections: {
      read: async () => ({
        namespace: boardProjection.name,
        key: 'global',
        lastGlobalPosition: 1,
        value: view,
      }),
    },
    journal: { readAll: async () => [event] },
    resources: { correlationsForWork: async () => [] },
  } as unknown as CompositionRoot;
}

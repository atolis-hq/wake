import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../src-next/activities/index.js';
import { compileWorkflow } from '../../src-next/orchestration/index.js';

function registry() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  return activities;
}

function config(watch: Record<string, unknown>) {
  return {
    stages: {
      implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
    },
    watches: [watch],
  };
}

it('accepts event, schedule, and combined watch triggers', () => {
  const base = {
    id: 'review',
    while: { stages: ['implement'], statuses: ['active'] },
    workflow: 'review',
    maxPerGroup: 1,
  };
  for (const trigger of [
    { on: { events: ['review.requested'] } },
    { schedule: { cron: '0 * * * *' } },
    { on: { events: ['review.requested'] }, schedule: { cron: '0 * * * *' } },
  ])
    expect(
      compileWorkflow('parent', config({ ...base, ...trigger }), registry(), ['parent', 'review'])
        .watches,
    ).toHaveLength(1);
});

it.each([
  [
    'unknown watch stage',
    {
      id: 'review',
      while: { stages: ['missing'], statuses: ['active'] },
      on: { events: ['review.requested'] },
      workflow: 'review',
      maxPerGroup: 1,
    },
  ],
  [
    'unknown watch workflow',
    {
      id: 'review',
      while: { stages: ['implement'], statuses: ['active'] },
      on: { events: ['review.requested'] },
      workflow: 'missing',
      maxPerGroup: 1,
    },
  ],
  [
    'positive group maximum',
    {
      id: 'review',
      while: { stages: ['implement'], statuses: ['active'] },
      on: { events: ['review.requested'] },
      workflow: 'review',
      maxPerGroup: 0,
    },
  ],
  [
    'canonical event names',
    {
      id: 'review',
      while: { stages: ['implement'], statuses: ['active'] },
      on: { events: ['Review Requested'] },
      workflow: 'review',
      maxPerGroup: 1,
    },
  ],
  [
    'a trigger',
    {
      id: 'review',
      while: { stages: ['implement'], statuses: ['active'] },
      workflow: 'review',
      maxPerGroup: 1,
    },
  ],
])('validates %s independently', (_requirement, watch) => {
  expect(() =>
    compileWorkflow('parent', config(watch), registry(), ['parent', 'review']),
  ).toThrow();
});

it('rejects duplicate watch ids', () => {
  const watch = {
    id: 'review',
    while: { stages: ['implement'], statuses: ['active'] },
    on: { events: ['review.requested'] },
    workflow: 'review',
    maxPerGroup: 1,
  };
  const input = config(watch);
  input.watches.push({ ...watch, on: { events: ['review.updated'] } });
  expect(() => compileWorkflow('parent', input, registry(), ['parent', 'review'])).toThrow(
    /Duplicate watch id/,
  );
});

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { analyticsProjection } from '../../../src-next/bootstrap/analytics-projection.js';

it('maintains analytics incrementally without journal.readAll() in a request handler', async () => {
  expect(analyticsProjection.name).toBe('operator-analytics');
  const applications = await readFile('src-next/bootstrap/surface-api-applications.ts', 'utf8');
  const observability = applications.slice(
    applications.indexOf('function createObservabilityApplications'),
  );
  expect(observability).not.toContain('journal.readAll');
  expect(observability).toContain('projections.read<AnalyticsProjectionView>');
});

it('returns bounded analytics windows with an explicit as-of position', async () => {
  const initial = analyticsProjection.initial('global');
  expect(initial).toEqual({ events: 0, workItems: 0, runs: 0, days: {} });
  expect(analyticsProjection.select).toBeTypeOf('function');
  const applications = await readFile('src-next/bootstrap/surface-api-applications.ts', 'utf8');
  const observability = applications.slice(
    applications.indexOf('function createObservabilityApplications'),
  );
  expect(observability).toContain('analyticsWindow(analytics, collectedAt, query.days)');
  expect(observability).toContain('meta: await projectionMeta');
});

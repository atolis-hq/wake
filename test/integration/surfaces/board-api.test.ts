import { describe, expect, it } from 'vitest';
import type { ApiApplications } from '../../../src/surfaces/api/routes/index.js';
import { createApiDispatcher } from '../../../src/surfaces/api/routes/index.js';

describe('operator board API', () => {
  it('serves operator facts without display-only fields', async () => {
    const dispatcher = createApiDispatcher(applications());

    const response = await dispatcher.dispatch('GET', '/api/v1/board', undefined);

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({
      items: [
        {
          workItemKey: 'wk_demo',
          condition: 'active',
          workflowName: 'delivery',
          stage: 'implement',
          dwellSince: '2026-08-01T10:00:00.000Z',
          runCount: 2,
        },
      ],
      conditionCounts: { active: 1 },
    });
    expect(JSON.stringify(response?.body)).not.toMatch(/colour|color|column|github/i);
  });
});

function applications(): ApiApplications {
  return {
    now: () => '2026-08-01T10:00:00.000Z',
    board: {
      list: async () => ({
        items: [
          {
            workItemKey: 'wk_demo',
            workItemId: 'work-demo',
            objective: 'Demo',
            condition: 'active',
            workflowName: 'delivery',
            stage: 'implement',
            dwellSince: '2026-08-01T10:00:00.000Z',
            runCount: 2,
            totalTokens: 0,
            totalCostUsd: 0,
            totalDurationMs: 0,
          },
        ],
        conditionCounts: { active: 1 },
        meta: { asOf: '2026-08-01T10:00:00.000Z', position: 4 },
      }),
    },
    status: {
      get: async () => ({
        data: { conditionCounts: { active: 1 } },
        meta: { asOf: '2026-08-01T10:00:00.000Z', position: 4 },
      }),
    },
    controlPlane: {
      status: async () => ({
        data: { paused: false, updatedAt: '2026-08-01T10:00:00.000Z' },
        meta: { asOf: '2026-08-01T10:00:00.000Z' },
      }),
    },
    work: {
      list: async () => ({ items: [], meta: { asOf: '2026-08-01T10:00:00.000Z' } }),
      detail: async () => undefined,
    },
    resources: { list: async () => ({ items: [], meta: { asOf: '2026-08-01T10:00:00.000Z' } }) },
    orchestration: {
      list: async () => ({ items: [], meta: { asOf: '2026-08-01T10:00:00.000Z' } }),
    },
    execution: { list: async () => ({ items: [], meta: { asOf: '2026-08-01T10:00:00.000Z' } }) },
    events: { list: async () => ({ items: [], meta: { asOf: '2026-08-01T10:00:00.000Z' } }) },
    observability: {
      metrics: async () => ({
        data: {
          collectedAt: '2026-08-01T10:00:00.000Z',
          window: { days: 7, from: '2026-07-25', to: '2026-07-31' },
          values: {},
        },
        meta: { asOf: '2026-08-01T10:00:00.000Z' },
      }),
    },
    system: {
      health: async () => ({
        data: { status: 'ok', version: '0.1.0-test', checkedAt: '2026-08-01T10:00:00.000Z' },
        meta: { asOf: '2026-08-01T10:00:00.000Z' },
      }),
      configuration: async () => ({
        data: { configuration: {} },
        meta: { asOf: '2026-08-01T10:00:00.000Z' },
      }),
    },
  };
}

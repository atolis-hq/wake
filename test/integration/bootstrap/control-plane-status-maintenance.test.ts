import { describe, expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { readControlPlaneStatus } from '../../../src/bootstrap/surface-api-applications.js';

const now = () => '2026-08-21T00:00:00.000Z';

function rootWithMaintenance(
  maintenance: Awaited<ReturnType<CompositionRoot['maintenance']['read']>>,
): CompositionRoot {
  return {
    projections: { read: async () => null },
    journal: {},
    maintenance: { read: async () => maintenance },
  } as unknown as CompositionRoot;
}

describe('readControlPlaneStatus', () => {
  it('omits maintenance when no lease is retained', async () => {
    const status = await readControlPlaneStatus(rootWithMaintenance(null), now);

    expect(status.data).not.toHaveProperty('maintenanceLease');
  });

  it('surfaces a retained failed lease alongside its phase, start time, and failure reason', async () => {
    const status = await readControlPlaneStatus(
      rootWithMaintenance({
        attemptId: 'attempt-1',
        tag: 'v2',
        phase: 'failed',
        startedAt: '2026-08-20T22:34:48.328Z',
        failure: 'active Runs remain after maintenance cancellation: run-1',
      }),
      now,
    );

    expect(status.data.maintenanceLease).toEqual({
      phase: 'failed',
      startedAt: '2026-08-20T22:34:48.328Z',
      failure: 'active Runs remain after maintenance cancellation: run-1',
    });
  });

  it('surfaces an in-progress lease without a failure field', async () => {
    const status = await readControlPlaneStatus(
      rootWithMaintenance({
        attemptId: 'attempt-2',
        tag: 'v3',
        phase: 'updating',
        startedAt: '2026-08-21T00:00:00.000Z',
      }),
      now,
    );

    expect(status.data.maintenanceLease).toEqual({
      phase: 'updating',
      startedAt: '2026-08-21T00:00:00.000Z',
    });
  });
});

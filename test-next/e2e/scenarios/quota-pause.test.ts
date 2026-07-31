import { expect, it } from 'vitest';
import { QuotaPolicy } from '../../../src-next/control-plane/index.js';

it('E2E-CONTROL-003: quota pause survives restart without spending dispatch budget', () => {
  const policy = new QuotaPolicy({ maxDispatches: 1, pauseDurationMs: 60_000 });
  const paused = policy.decide('2026-07-31T12:00:00.000Z', 1, null);
  expect(paused.kind).toBe('pause');
  if (paused.kind !== 'pause') return;
  expect(policy.decide('2026-07-31T12:00:30.000Z', 1, paused.resumeAt)).toMatchObject({
    kind: 'paused',
  });
});

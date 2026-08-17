import { describe, expect, it } from 'vitest';
import { createAdapterHealthTracker } from '../../../src/integrations/application/adapter-health-tracker.js';

describe('createAdapterHealthTracker', () => {
  it('starts ok with zeroed counters', () => {
    const tracker = createAdapterHealthTracker();

    expect(tracker.snapshot()).toEqual({
      status: 'ok',
      successCount: 0,
      failureCount: 0,
    });
  });

  it('stays ok after a single transient failure', () => {
    const tracker = createAdapterHealthTracker();

    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));

    const snapshot = tracker.snapshot();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.successCount).toBe(0);
  });

  it('degrades after three consecutive transient failures', () => {
    let now = 0;
    const tracker = createAdapterHealthTracker({ now: () => now });

    for (let i = 0; i < 2; i += 1) {
      now += 1_000;
      tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    }
    expect(tracker.snapshot().status).toBe('ok');

    now += 1_000;
    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));

    const snapshot = tracker.snapshot();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.failureCount).toBe(3);
    expect(snapshot.detail).toContain('3 consecutive failures');
    expect(snapshot.detail).toContain('503');
  });

  it('resets consecutive-failure count and status on success', () => {
    const tracker = createAdapterHealthTracker();

    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    expect(tracker.snapshot().status).toBe('degraded');

    tracker.recordSuccess();

    const snapshot = tracker.snapshot();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.detail).toBeUndefined();
    expect(snapshot.successCount).toBe(1);
    expect(snapshot.failureCount).toBe(3);

    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    expect(tracker.snapshot().status).toBe('ok');
  });

  it('degrades immediately on a 429 rate-limit failure', () => {
    const tracker = createAdapterHealthTracker();

    tracker.recordFailure(Object.assign(new Error('rate limited'), { status: 429 }));

    const snapshot = tracker.snapshot();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.detail).toContain('429');
  });

  it.each([401, 403])('degrades immediately on a %i auth failure', (status) => {
    const tracker = createAdapterHealthTracker();

    tracker.recordFailure(Object.assign(new Error('auth rejected'), { status }));

    const snapshot = tracker.snapshot();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.detail).toContain(String(status));
  });

  it('accumulates success and failure counts across a mixed sequence', () => {
    const tracker = createAdapterHealthTracker();

    tracker.recordSuccess();
    tracker.recordFailure(Object.assign(new Error('upstream unavailable'), { status: 503 }));
    tracker.recordSuccess();
    tracker.recordSuccess();
    tracker.recordFailure(Object.assign(new Error('rate limited'), { status: 429 }));

    const snapshot = tracker.snapshot();
    expect(snapshot.successCount).toBe(3);
    expect(snapshot.failureCount).toBe(2);
    expect(snapshot.status).toBe('degraded');
  });
});

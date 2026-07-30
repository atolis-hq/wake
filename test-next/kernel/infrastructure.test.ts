import { describe, expect, it } from 'vitest';
import { SystemClock, UlidIdGenerator } from '../../src-next/kernel/index.js';

describe('kernel infrastructure', () => {
  it('reads the current system time', () => {
    const before = Date.now();
    const current = new SystemClock().now().getTime();
    const after = Date.now();

    expect(current).toBeGreaterThanOrEqual(before);
    expect(current).toBeLessThanOrEqual(after);
  });

  it('generates a prefixed lowercase ULID', () => {
    expect(new UlidIdGenerator().next('event')).toMatch(/^event-[0-9a-z]{26}$/);
  });

  it.each(['', 'Event', 'event_name', '1event'])('rejects invalid ID prefix %j', (prefix) => {
    expect(() => new UlidIdGenerator().next(prefix)).toThrow(`Invalid ID prefix: ${prefix}`);
  });
});

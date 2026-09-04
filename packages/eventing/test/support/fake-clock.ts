import type { EventingClock } from '@atolis-hq/eventing';

export class FakeClock implements EventingClock {
  now(): Date {
    return new Date('2026-08-31T12:00:00.000Z');
  }
}

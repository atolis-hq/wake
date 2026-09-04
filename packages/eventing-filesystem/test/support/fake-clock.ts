import type { EventingClock } from '@atolis-hq/eventing';

export class FakeClock implements EventingClock {
  private current = new Date('2026-07-30T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

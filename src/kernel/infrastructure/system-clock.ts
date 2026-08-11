import type { Clock } from '../contracts/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

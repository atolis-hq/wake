import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InProcessJournalChangeSignal } from '../../../src/kernel/index.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('resolves immediately when the signal is already aborted', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();
  controller.abort();

  let resolved = false;
  const wait = changeSignal.waitForChange(controller.signal, 10_000).then(() => {
    resolved = true;
  });
  await Promise.resolve();

  expect(resolved).toBe(true);
  await wait;
});

it('resolves as soon as notify() is called, before the fallback elapses', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();

  let resolved = false;
  const wait = changeSignal.waitForChange(controller.signal, 10_000).then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toBe(false);

  changeSignal.notify();
  await wait;

  expect(resolved).toBe(true);
});

it('resolves via the fallback timeout when notify() never fires', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();

  let resolved = false;
  const wait = changeSignal.waitForChange(controller.signal, 5_000).then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(resolved).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await wait;

  expect(resolved).toBe(true);
});

it('resolves when the caller aborts before either notify() or the fallback fires', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();

  let resolved = false;
  const wait = changeSignal.waitForChange(controller.signal, 10_000).then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toBe(false);

  controller.abort();
  await wait;

  expect(resolved).toBe(true);
});

it('coalesces multiple notify() calls between waitForChange() calls into exactly one wake-up', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();

  let wakeUps = 0;
  const wait = changeSignal.waitForChange(controller.signal, 10_000).then(() => {
    wakeUps += 1;
  });
  changeSignal.notify();
  changeSignal.notify();
  changeSignal.notify();
  await wait;

  expect(wakeUps).toBe(1);

  let secondResolved = false;
  const secondWait = changeSignal.waitForChange(controller.signal, 5_000).then(() => {
    secondResolved = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(secondResolved).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await secondWait;
  expect(secondResolved).toBe(true);
});

it('wakes multiple independent subscribers off a single notify() call', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const first = new AbortController();
  const second = new AbortController();

  let firstResolved = false;
  let secondResolved = false;
  const firstWait = changeSignal.waitForChange(first.signal, 10_000).then(() => {
    firstResolved = true;
  });
  const secondWait = changeSignal.waitForChange(second.signal, 10_000).then(() => {
    secondResolved = true;
  });

  changeSignal.notify();
  await Promise.all([firstWait, secondWait]);

  expect(firstResolved).toBe(true);
  expect(secondResolved).toBe(true);
});

it('does not leak a waiter that resolved via fallback into a later notify()', async () => {
  const changeSignal = new InProcessJournalChangeSignal();
  const controller = new AbortController();

  const timedOut = changeSignal.waitForChange(controller.signal, 100);
  await vi.advanceTimersByTimeAsync(100);
  await timedOut;

  // With no active waiter, notify() must be a no-op rather than resolving
  // a stale reference left behind by the fallback timeout above.
  expect(() => changeSignal.notify()).not.toThrow();

  let resolved = false;
  const wait = changeSignal.waitForChange(controller.signal, 10_000).then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toBe(false);

  changeSignal.notify();
  await wait;
  expect(resolved).toBe(true);
});

it('guarantee-preservation: a consumer loop still processes every event via fallback alone when notify() is never called', async () => {
  // notify() is never called — the consumer can only advance via fallback.
  const changeSignal = new InProcessJournalChangeSignal();
  const journal: number[] = [];
  let checkpoint = 0;
  const processed: number[] = [];
  const controller = new AbortController();
  const fallbackMs = 1_000;

  const consumer = (async () => {
    while (!controller.signal.aborted) {
      while (checkpoint < journal.length) {
        processed.push(journal[checkpoint]!);
        checkpoint += 1;
      }
      await changeSignal.waitForChange(controller.signal, fallbackMs);
    }
  })();

  journal.push(1, 2);
  await vi.advanceTimersByTimeAsync(fallbackMs);
  journal.push(3);
  await vi.advanceTimersByTimeAsync(fallbackMs);
  journal.push(4, 5);
  await vi.advanceTimersByTimeAsync(fallbackMs);

  controller.abort();
  await consumer;

  expect(processed).toEqual([1, 2, 3, 4, 5]);
});

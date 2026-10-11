import { expect, it, vi } from 'vitest';
import { median } from '../../../src/kernel/index.js';

it('computes exact odd, even and empty medians while yielding throughout a large population', async () => {
  const pause = vi.fn(async () => {});
  expect(await median([], pause)).toBeNull();
  expect(await median([7, 1, 4, 2], pause)).toBe(3);
  const population = Array.from({ length: 2501 }, (_, index) => 2500 - index);
  expect(await median(population, pause)).toBe(1250);
  expect(pause.mock.calls.length).toBeGreaterThan(3);
  expect(population[0]).toBe(2500);
});

it('lets cancellation interrupt median calculation between bounded chunks', async () => {
  const pause = vi.fn(async () => {
    if (pause.mock.calls.length === 2) throw new Error('Cancelled');
  });
  await expect(
    median(
      Array.from({ length: 3000 }, (_, index) => index),
      pause,
    ),
  ).rejects.toThrow('Cancelled');
  expect(pause).toHaveBeenCalledTimes(2);
});

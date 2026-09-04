import { WrongExpectedSequenceError } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import {
  appendWithIntentRecovery,
  claimWithCasRetry,
} from '../../../src/orchestration/application/durable-append.js';

it('treats a concurrent durable winner as an optimistic-append success', async () => {
  let loaded = false;
  const result = await appendWithIntentRecovery({
    append: async () => {
      loaded = true;
      throw new WrongExpectedSequenceError();
    },
    load: async () => ({ loaded }),
    alreadyApplied: (view) => view.loaded,
  });
  expect(result).toEqual({ loaded: true });
});

it('propagates an append error when the intended state was not applied', async () => {
  const failure = new Error('journal offline');
  await expect(
    appendWithIntentRecovery({
      append: async () => Promise.reject(failure),
      load: async () => ({ applied: false }),
      alreadyApplied: (view) => view.applied,
    }),
  ).rejects.toBe(failure);
});

it('does not append a claim that is already present', async () => {
  let appends = 0;
  const claimed = await claimWithCasRetry({
    read: async () => ['claim'],
    decode: (events) => events,
    alreadyClaimed: (events) => events.includes('claim'),
    append: async () => {
      appends += 1;
    },
  });
  expect(claimed).toBe(false);
  expect(appends).toBe(0);
});

it('retries a CAS loser and stops once the competing claim is visible', async () => {
  let reads = 0;
  const claimed = await claimWithCasRetry({
    read: async () => (reads++ === 0 ? [] : ['claim']),
    decode: (events) => events,
    alreadyClaimed: (events) => events.includes('claim'),
    append: async () => Promise.reject(new WrongExpectedSequenceError()),
  });
  expect(claimed).toBe(false);
  expect(reads).toBe(2);
});

it('propagates a non-CAS claim append error', async () => {
  const failure = new Error('journal offline');
  await expect(
    claimWithCasRetry({
      read: async () => [],
      decode: (events) => events,
      alreadyClaimed: () => false,
      append: async () => Promise.reject(failure),
    }),
  ).rejects.toBe(failure);
});

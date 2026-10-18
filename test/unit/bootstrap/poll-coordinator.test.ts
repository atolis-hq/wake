import { acquireFileLock } from '@atolis-hq/eventing-filesystem';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollCoordinator, PollOutcome } from '../../../src/bootstrap/poll-coordinator.js';
import { adapterId } from '../../../src/integrations/contracts/identifiers.js';
import type { ProviderInstance } from '../../../src/integrations/contracts/provider.js';

const adapter = adapterId('github');
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wake-poll-coordinator-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function providerWith(poll: ProviderInstance['source']['poll']) {
  const failures: unknown[] = [];
  const provider = {
    adapter,
    source: { poll },
    eventTypes: [],
    recordPollFailure: (error: unknown) => failures.push(error),
  } as unknown as ProviderInstance;
  return { provider, failures };
}

function coordinator(options: { deadlineMs?: number; lockWaitMs?: number } = {}) {
  return createPollCoordinator({
    journal: new InMemoryEventJournal({ now: () => new Date('2026-10-18T00:00:00.000Z') }),
    wakeRoot: root,
    ...options,
  });
}

describe('poll coordinator', () => {
  it('joins an in-flight webhook poll from intake instead of failing the tick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poll = vi.fn(async () => {
      await gate;
      return [];
    });
    const { provider, failures } = providerWith(poll);
    const polls = coordinator();
    const signal = new AbortController().signal;

    const immediate = polls.poll(provider, signal, { bypassInterval: true });
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    const intake = polls.poll(provider, signal);
    release();

    await expect(intake).resolves.toMatchObject({ outcome: PollOutcome.Polled });
    await immediate;
    expect(poll).toHaveBeenCalledOnce();
    expect(failures).toEqual([]);
  });

  it('releases the lock at the deadline when the source hangs and ignores abort', async () => {
    const hung = vi.fn(() => new Promise<never>(() => undefined));
    const { provider, failures } = providerWith(hung);
    const polls = coordinator({ deadlineMs: 30 });

    await expect(polls.poll(provider, new AbortController().signal)).rejects.toThrow(/deadline/);
    expect(failures).toHaveLength(1);

    const healthy = providerWith(async () => []);
    await expect(polls.poll(healthy.provider, new AbortController().signal)).resolves.toEqual({
      outcome: PollOutcome.Polled,
      appended: 0,
    });
  });

  it('reports cross-process lock contention as a health failure without throwing', async () => {
    const lock = await acquireFileLock(join(root, '.wake', 'locks', `poll-${adapter}.lock`), {
      staleRequiresDeadProcess: true,
    });
    expect(lock.acquired).toBe(true);
    const poll = vi.fn(async () => []);
    const { provider, failures } = providerWith(poll);

    try {
      const result = await coordinator({ lockWaitMs: 50 }).poll(
        provider,
        new AbortController().signal,
      );
      expect(result).toEqual({ outcome: PollOutcome.LockContended, appended: 0 });
      expect(poll).not.toHaveBeenCalled();
      expect(failures).toHaveLength(1);
    } finally {
      await lock.release();
    }
  });

  it('polls normally once the contention clears', async () => {
    const lock = await acquireFileLock(join(root, '.wake', 'locks', `poll-${adapter}.lock`), {
      staleRequiresDeadProcess: true,
    });
    const poll = vi.fn(async () => []);
    const { provider } = providerWith(poll);
    const polls = coordinator({ lockWaitMs: 20 });
    const signal = new AbortController().signal;

    expect((await polls.poll(provider, signal)).outcome).toBe(PollOutcome.LockContended);
    await lock.release();
    expect((await polls.poll(provider, signal)).outcome).toBe(PollOutcome.Polled);
    expect(poll).toHaveBeenCalledOnce();
  });
});

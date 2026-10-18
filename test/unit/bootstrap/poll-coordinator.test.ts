import { createEventData } from '@atolis-hq/eventing';
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

// Models the GitHub source's watermark contract: a watermark queued by poll() is
// saved only by markPollPersisted(), and an aborted poll queues nothing.
function remoteComments() {
  const comments: number[] = [];
  let saved = 0;
  let pending: number | undefined;
  let nextFailures = 0;
  let gate: Promise<void> | undefined;
  const poll: ProviderInstance['source']['poll'] = async (signal) => {
    if (nextFailures > 0) {
      nextFailures -= 1;
      throw new Error('GitHub unavailable');
    }
    const seen = comments.filter((id) => id > saved);
    await gate;
    signal.throwIfAborted();
    if (seen.length > 0) pending = Math.max(...seen);
    return seen.map((id) =>
      createEventData({
        eventId: `github:comment:${id}`,
        eventType: 'integration.github.work-observed',
        occurredAt: '2026-10-18T19:50:00.000Z',
        correlationId: 'github:owner/repo#960',
        causationId: `github:comment:${id}`,
        actor: { kind: 'integration', id: 'github' },
        source: { kind: 'adapter', id: 'github' },
        payload: { externalKey: 'owner/repo#960' },
      }),
    );
  };
  const markPollPersisted = async () => {
    if (pending === undefined) return;
    saved = pending;
    pending = undefined;
  };
  return {
    comments,
    poll,
    markPollPersisted,
    saved: () => saved,
    failNext: (count: number) => {
      nextFailures = count;
    },
    holdPolls: () => {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
  };
}

function observingProvider(remote: ReturnType<typeof remoteComments>) {
  const failures: unknown[] = [];
  const provider = {
    adapter,
    source: { poll: remote.poll, markPollPersisted: remote.markPollPersisted },
    eventTypes: ['integration.github.work-observed'],
    recordPollFailure: (error: unknown) => failures.push(error),
  } as unknown as ProviderInstance;
  return { provider, failures };
}

describe('poll coordinator observation durability', () => {
  const signal = new AbortController().signal;
  const newJournal = () =>
    new InMemoryEventJournal({ now: () => new Date('2026-10-18T00:00:00.000Z') });
  const eventIds = async (journal: InMemoryEventJournal) =>
    (await journal.readAll(0)).map(({ event }) => event.eventId);

  it('observes a comment created while an immediate poll and an intake tick contended', async () => {
    const journal = newJournal();
    const polls = createPollCoordinator({ journal, wakeRoot: root });
    const remote = remoteComments();
    const { provider } = observingProvider(remote);
    remote.comments.push(1);
    const release = remote.holdPolls();

    const immediate = polls.poll(provider, signal, { bypassInterval: true });
    const intake = polls.poll(provider, signal);
    remote.comments.push(2); // arrives during the contention window
    release();
    await Promise.all([immediate, intake]);
    await polls.poll(provider, signal);

    expect(await eventIds(journal)).toEqual(['github:comment:1', 'github:comment:2']);
    expect(remote.saved()).toBe(2);
  });

  it('observes comments created while polling was failing once polling resumes', async () => {
    const journal = newJournal();
    const polls = createPollCoordinator({ journal, wakeRoot: root });
    const remote = remoteComments();
    const { provider, failures } = observingProvider(remote);
    remote.failNext(3);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      remote.comments.push(attempt + 1);
      await expect(polls.poll(provider, signal)).rejects.toThrow('GitHub unavailable');
    }
    expect(failures).toHaveLength(3);
    expect(await eventIds(journal)).toEqual([]);

    await polls.poll(provider, signal);

    expect(await eventIds(journal)).toEqual([
      'github:comment:1',
      'github:comment:2',
      'github:comment:3',
    ]);
  });

  it('never lets a poll that overran its deadline advance the watermark past persisted events', async () => {
    const journal = newJournal();
    const polls = createPollCoordinator({ journal, wakeRoot: root, deadlineMs: 30 });
    const remote = remoteComments();
    const { provider } = observingProvider(remote);
    remote.comments.push(1);
    const release = remote.holdPolls();

    await expect(polls.poll(provider, signal)).rejects.toThrow(/deadline/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the leaked run settle
    expect(remote.saved()).toBe(0);
    expect(await eventIds(journal)).toEqual([]);

    remote.comments.push(2);
    await polls.poll(provider, signal);

    expect(await eventIds(journal)).toEqual(['github:comment:1', 'github:comment:2']);
    expect(remote.saved()).toBe(2);
  });
});

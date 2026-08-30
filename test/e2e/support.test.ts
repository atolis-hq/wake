import { describe, expect, it } from 'vitest';
import { createEventData, type EventEnvelope } from '../../src/kernel/index.js';
import { workItemStream } from '../../src/work/index.js';
import { workId } from '../support/identities.js';
import { FaultInjector, InjectedFaultError } from './support/faults.js';
import { formatTrace } from './support/trace.js';
import { FakeClock, SequentialIds, TestWorld } from './support/world.js';

describe('event-model support', () => {
  it('advances deterministic time without exposing its mutable date', () => {
    const clock = new FakeClock();
    const first = clock.now();
    first.setUTCFullYear(2030);

    clock.advance(250);

    expect(clock.now().toISOString()).toBe('2026-07-30T12:00:00.250Z');
  });

  it('assigns sequential IDs across prefixes', () => {
    const ids = new SequentialIds();

    expect([ids.next('event'), ids.next('command'), ids.next('event')]).toEqual([
      'event-1',
      'command-2',
      'event-3',
    ]);
  });

  it('injects an armed fault once and then disarms it', () => {
    const faults = new FaultInjector();
    faults.failOnce('journal.append');

    expect(() => faults.check('journal.append')).toThrow(InjectedFaultError);
    expect(() => faults.check('journal.append')).not.toThrow();
  });

  it('routes TestWorld journal appends through before and after fault boundaries', async () => {
    const world = new TestWorld();
    world.faults.failOnce('journal.append.before');

    await expect(world.createWork({ objective: 'before fault' })).rejects.toMatchObject({
      faultName: 'journal.append.before',
    });

    world.faults.failOnce('journal.append.after');
    await expect(world.createWork({ objective: 'after fault' })).rejects.toMatchObject({
      faultName: 'journal.append.after',
    });
    expect((await world.events('work.item-created')).length).toBe(1);
  });

  it('formats stable causal traces without recorded time', () => {
    const draft = createEventData({
      eventId: 'evt-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cmd-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: workItemStream(workId('1')),
      payload: { objective: 'test' },
    });
    const envelope: EventEnvelope = {
      ...draft,
      recordedAt: '2099-01-01T00:00:00.000Z',
      sequence: 1,
      globalPosition: 3,
    };

    expect(formatTrace([envelope])).toBe(
      `3 work.item-created stream=work-item:${workId('1')} cause=cmd-1 payload={"objective":"test"}`,
    );
    expect(formatTrace([])).toBe('');
  });
});

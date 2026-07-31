import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef } from '../../src-next/kernel/index.js';
import { createWatchReactor } from '../../src-next/orchestration/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { FakeClock } from '../e2e/support/world.js';

it('rejects a causal event instead of dispatching another child', async () => {
  const rejected: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: 'parent-1' },
          watch: { id: 'review', workflow: 'review', maxPerGroup: 1 },
        },
      ];
    },
    async requestChild() {
      throw new Error('must not dispatch a causal child');
    },
    async rejectCausalActivation(request) {
      rejected.push(request.parentWorkflowInstanceId);
    },
    async isCausalRepeat() {
      return true;
    },
  });

  await reactor.react(
    {
      eventType: 'orchestration.child-completed',
      eventId: 'child-1',
      payload: { causalCycleId: 'cycle-1' },
    },
    {
      commandId: 'react-1',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-07-30T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  expect(rejected).toEqual(['parent-1']);
});

it('matches a durable schedule slot by its configured cron identity', async () => {
  const matches: Array<[string, string | undefined]> = [];
  const reactor = createWatchReactor({
    async listWatchMatches(eventType: string, cron?: string) {
      matches.push([eventType, cron]);
      return [];
    },
    async requestChild() {},
    async rejectCausalActivation() {},
  });
  await reactor.react(
    { eventType: 'control.schedule-slot', eventId: 'slot-1', payload: { cron: '0 * * * *' } },
    {
      commandId: 'react-1',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-07-30T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  expect(matches).toEqual([['control.schedule-slot', '0 * * * *']]);
});

it('does not reject an unrelated causal event', async () => {
  const requested: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: 'parent-1' },
          watch: { id: 'review', workflow: 'review', maxPerGroup: 1 },
        },
      ];
    },
    async requestChild(request) {
      requested.push(request.watchId);
      return {};
    },
    async rejectCausalActivation() {
      throw new Error('unrelated cycle must not reject');
    },
    async isCausalRepeat() {
      return false;
    },
  });
  await reactor.react(
    {
      eventType: 'review.requested',
      eventId: 'review-1',
      payload: { causalCycleId: 'other-cycle' },
    },
    {
      commandId: 'react-1',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-07-30T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  expect(requested).toEqual(['review']);
});

it('keeps its checkpoint unchanged until every watch request succeeds', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  const stream: EntityRef<'test', 'watch-reactor'> = {
    kind: 'test',
    id: 'watch-reactor',
  };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-1',
      eventType: 'review.requested',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    }),
  ]);
  let failSecond = true;
  const attempts: string[] = [];
  const reactor = createWatchReactor(
    {
      async listWatchMatches() {
        return ['first', 'second'].map((id) => ({
          parent: { workflowInstanceId: 'parent-1' },
          watch: { id, workflow: 'review', maxPerGroup: 2 },
        }));
      },
      async requestChild(request, context) {
        attempts.push(`${request.watchId}:${context.commandId}`);
        if (request.watchId === 'second' && failSecond) {
          failSecond = false;
          throw new Error('injected request failure');
        }
        return {};
      },
      async rejectCausalActivation() {},
    },
    journal,
    checkpoints,
  );

  await expect(reactor.runOnce()).rejects.toThrow('injected request failure');
  expect(await checkpoints.load('reactor:orchestration.watch')).toBe(0);

  await expect(reactor.runOnce()).resolves.toBe(1);
  expect(await checkpoints.load('reactor:orchestration.watch')).toBe(1);
  expect(attempts).toEqual([
    'first:event-1:watch:parent:parent-1:watch:first:trigger:event-1',
    'second:event-1:watch:parent:parent-1:watch:second:trigger:event-1',
    'first:event-1:watch:parent:parent-1:watch:first:trigger:event-1',
    'second:event-1:watch:parent:parent-1:watch:second:trigger:event-1',
  ]);
});

it('scopes dispatch and rejection command identities to the parent and watch', async () => {
  const dispatched: string[] = [];
  const rejected: string[] = [];
  const matches = ['parent-a', 'parent-b'].map((workflowInstanceId) => ({
    parent: { workflowInstanceId },
    watch: { id: 'review', workflow: 'review', maxPerGroup: 1 },
  }));
  const event = { eventType: 'review.requested', eventId: 'event-1', payload: {} };
  const context = {
    commandId: 'event-1:watch',
    correlationId: 'corr-1' as never,
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'system' as const, id: 'test' },
  };
  await createWatchReactor({
    async listWatchMatches() {
      return matches;
    },
    async requestChild(_request, command) {
      dispatched.push(command.commandId);
      return {};
    },
    async rejectCausalActivation() {},
    async isCausalRepeat() {
      return false;
    },
  }).react(event, context);
  await createWatchReactor({
    async listWatchMatches() {
      return matches;
    },
    async requestChild() {},
    async rejectCausalActivation(_request, command) {
      rejected.push(command.commandId);
    },
    async isCausalRepeat() {
      return true;
    },
  }).react(event, context);

  const expected = [
    'event-1:watch:parent:parent-a:watch:review:trigger:event-1',
    'event-1:watch:parent:parent-b:watch:review:trigger:event-1',
  ];
  expect(dispatched).toEqual(expected);
  expect(rejected).toEqual(expected);
});

it('replays the identical child request after checkpoint persistence fails', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'test', 'checkpoint-replay'> = {
    kind: 'test',
    id: 'checkpoint-replay',
  };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-replay-1',
      eventType: 'review.requested',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    }),
  ]);
  const durable = new InMemoryCheckpointStore();
  let failSave = true;
  const checkpoints = {
    load: (consumer: string) => durable.load(consumer),
    async save(consumer: string, position: number) {
      if (failSave) {
        failSave = false;
        throw new Error('injected checkpoint failure');
      }
      await durable.save(consumer, position);
    },
    reset: (consumer: string) => durable.reset(consumer),
  };
  let durableRequestId: string | undefined;
  let requests = 0;
  let rejections = 0;
  const reactor = createWatchReactor(
    {
      async listWatchMatches() {
        return [
          {
            parent: { workflowInstanceId: 'parent-1' },
            watch: { id: 'review', workflow: 'review', maxPerGroup: 1 },
          },
        ];
      },
      async requestChild(request) {
        durableRequestId = request.requestId;
        requests += 1;
        return {};
      },
      async rejectCausalActivation() {
        rejections += 1;
      },
      async isCausalRepeat(_parent, _event, _payload, requestId: string) {
        return durableRequestId !== undefined && durableRequestId !== requestId;
      },
    },
    journal,
    checkpoints,
  );

  await expect(reactor.runOnce()).rejects.toThrow('injected checkpoint failure');
  expect(await durable.load('reactor:orchestration.watch')).toBe(0);
  await expect(reactor.runOnce()).resolves.toBe(1);
  expect(await durable.load('reactor:orchestration.watch')).toBe(1);
  expect(requests).toBe(2);
  expect(rejections).toBe(0);
});

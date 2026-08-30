import { expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { EventProcessorHost } from '../../../src/eventing/index.js';
import {
  ExecutionEventType,
  runId,
  RunStatus,
  runStream,
  type RunRepository,
} from '../../../src/execution/index.js';
import { createEventData, eventId, type EntityRef } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  createWatchReactor,
  createWatchReconciler,
  OrchestrationEventType,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../../src/orchestration/index.js';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';

it('exposes the stable watch processor while retaining react as the business handler', () => {
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [];
    },
    async requestChild() {},
    async rejectCausalActivation() {},
  });

  expect(reactor).toMatchObject({
    processor: {
      consumer: 'reactor:orchestration.watch',
      name: 'watch',
      owner: 'orchestration',
    },
  });
  expect(typeof reactor.react).toBe('function');
});

it('ignores facts outside the configured watch event types through its processor selector', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.append(watchStream, 0, [
    createEventData({
      eventId: 'unrelated-watch-fact',
      eventType: 'work.created',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: watchStream,
      payload: {},
    }),
  ]);
  let matched = 0;
  const reactor = createWatchReactor(
    {
      async listWatchMatches() {
        matched += 1;
        return [];
      },
      async requestChild() {},
      async rejectCausalActivation() {},
    },
    () => ['review.requested'],
  );
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({
    eventCount: 1,
    handledCount: 0,
  });
  expect(matched).toBe(0);
});

const watchStream: EntityRef<'test', 'watch-reactor'> = {
  kind: 'test',
  id: 'watch-reactor',
};

const canonicalEvent = (
  eventType: string,
  id: string,
  payload: unknown,
  stream: EntityRef = watchStream,
) => ({
  ...eventEnvelope(eventType, payload, stream),
  eventId: eventId(id),
});

it('rejects a malformed owned orchestration envelope before routing watches', async () => {
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [];
    },
    async requestChild() {},
    async rejectCausalActivation() {},
  });
  const malformed = eventEnvelope(
    OrchestrationEventType.ChildCompleted,
    { causalCycleId: 'cycle-1' },
    workflowInstanceStream(workflowInstanceId('workflow-1')),
  );

  await expect(
    reactor.react(malformed, {
      commandId: 'react-malformed',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-07-30T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    }),
  ).rejects.toThrow(/invalid orchestration event/i);
});

it('does not inspect an unrelated domain payload for causal metadata', async () => {
  const payload = {};
  Object.defineProperty(payload, 'causalCycleId', {
    get() {
      throw new Error('unrelated payload was inspected');
    },
  });
  let comparedCycle: string | undefined = 'not-called';
  let requestedCycle: string | undefined;
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: workflowInstanceId('parent-1') },
          watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
        },
      ];
    },
    async requestChild(request) {
      requestedCycle = request.causalCycleId;
      return {};
    },
    async rejectCausalActivation() {},
    async isCausalRepeat(_parent, _event, cycle) {
      comparedCycle = typeof cycle === 'string' ? cycle : undefined;
      return false;
    },
  });

  await reactor.react(canonicalEvent('review.requested', 'review-opaque', payload), {
    commandId: 'react-opaque',
    correlationId: 'corr-1' as never,
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'system', id: 'test' },
  });

  expect(comparedCycle).toBeUndefined();
  expect(requestedCycle).toBe('parent-1:watch:review:trigger:review-opaque');
});

it('passes the persisted event to watch matching so predicates can decode its payload', async () => {
  let matchedEvent: { readonly eventType: string; readonly payload: unknown } | undefined;
  const event = canonicalEvent('pr.checks-changed', 'checks-failed', { checks: 'failing' });
  const reactor = createWatchReactor({
    async listWatchMatches(candidate) {
      matchedEvent = candidate;
      return [];
    },
    async requestChild() {},
    async rejectCausalActivation() {},
  });

  await reactor.react(event, {
    commandId: 'react-checks',
    correlationId: 'corr-1' as never,
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'system', id: 'test' },
  });

  expect(matchedEvent).toMatchObject({
    eventType: 'pr.checks-changed',
    payload: { checks: 'failing' },
  });
});

it('rejects a causal event instead of dispatching another child', async () => {
  const rejected: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: workflowInstanceId('parent-1') },
          watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
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
    canonicalEvent(
      OrchestrationEventType.ChildCompleted,
      'child-1',
      {
        parentWorkflowInstanceId: workflowInstanceId('parent-1'),
        watchId: 'review',
        triggerId: 'trigger-1',
        orchestrationGroupId: orchestrationGroupId('group-1'),
        causalCycleId: 'cycle-1',
        requestId: 'request-1',
        childWorkflowInstanceId: workflowInstanceId('workflow-child'),
      },
      workflowInstanceStream(workflowInstanceId('workflow-child')),
    ),
    {
      commandId: 'react-1',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-07-30T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  expect(rejected).toEqual(['parent-1']);
});

it('does not reject an unrelated causal event', async () => {
  const requested: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: workflowInstanceId('parent-1') },
          watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
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
    canonicalEvent('review.requested', 'review-1', {
      causalCycleId: 'other-cycle',
    }),
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
    createEventData({
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
          parent: { workflowInstanceId: workflowInstanceId('parent-1') },
          watch: { id, workflow: workflowName('review'), maxPerGroup: 2 },
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
    () => ['review.requested'],
  );
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  await expect(host.runOnce(reactor.processor)).rejects.toThrow('injected request failure');
  expect(await checkpoints.load('reactor:orchestration.watch')).toBe(0);

  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 1 });
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
  const matches = ['parent-a', 'parent-b'].map((id) => ({
    parent: { workflowInstanceId: workflowInstanceId(id) },
    watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
  }));
  const event = canonicalEvent('review.requested', 'event-1', {});
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
    createEventData({
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
            parent: { workflowInstanceId: workflowInstanceId('parent-1') },
            watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
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
    () => ['review.requested'],
  );
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  await expect(host.runOnce(reactor.processor)).rejects.toThrow('injected checkpoint failure');
  expect(await durable.load('reactor:orchestration.watch')).toBe(0);
  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 1 });
  expect(await durable.load('reactor:orchestration.watch')).toBe(1);
  expect(requests).toBe(2);
  expect(rejections).toBe(0);
});

it('reconciles a durable watch trigger orphaned after its checkpoint advanced', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.append(watchStream, 0, [
    createEventData({
      eventId: 'orphaned-trigger',
      eventType: 'review.requested',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'orphaned-trigger',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: watchStream,
      payload: {},
    }),
  ]);
  const requested: string[] = [];
  const checkpoints = new InMemoryCheckpointStore();
  const reconciler = createWatchReconciler(
    {
      async listWatchMatches() {
        return [
          {
            parent: { workflowInstanceId: workflowInstanceId('parent-1') },
            watch: { id: 'review', workflow: workflowName('review'), maxPerGroup: 1 },
          },
        ];
      },
      async listWaiting() {
        return [
          {
            workflowInstanceId: workflowInstanceId('parent-1'),
            waitingFor: { from: [{ kind: 'watch', watch: 'review' }] },
          },
        ] as never;
      },
      async requestChild(request) {
        requested.push(request.requestId);
        return {};
      },
      async rejectCausalActivation() {},
    },
    journal,
    checkpoints,
  );

  await expect(reconciler.reconcileOnce()).resolves.toBe(1);
  expect(requested).toEqual(['parent-1:watch:review:trigger:orphaned-trigger']);
  expect(await checkpoints.load('reconciler:orchestration.watch')).toBe(1);
  expect(await checkpoints.load('reactor:orchestration.watch')).toBe(0);
});

it('scopes an orchestration state-transition event to its own stream, not an unrelated match', async () => {
  const requested: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: workflowInstanceId('primary:work-a') },
          watch: { id: 'plan-review', workflow: workflowName('plan-review'), maxPerGroup: 1 },
        },
        {
          parent: { workflowInstanceId: workflowInstanceId('primary:work-b') },
          watch: { id: 'plan-review', workflow: workflowName('plan-review'), maxPerGroup: 1 },
        },
      ];
    },
    async requestChild(request) {
      requested.push(request.parentWorkflowInstanceId);
      return {};
    },
    async rejectCausalActivation() {
      throw new Error('must not reject; the unrelated match should simply be skipped');
    },
  });

  await reactor.react(
    canonicalEvent(
      OrchestrationEventType.SignalWaitStarted,
      'signal-wait-a',
      {
        signalKind: 'orchestration.watch-gate-verdict',
        from: [{ kind: 'watch', watch: 'plan-review' }],
      },
      workflowInstanceStream(workflowInstanceId('primary:work-a')),
    ),
    {
      commandId: 'react-signal-wait-a',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-08-14T20:07:41.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );

  expect(requested).toEqual(['primary:work-a']);
});

it('scopes a run-lifecycle event to the run owner, not an unrelated match', async () => {
  const requested: string[] = [];
  const runs: Pick<RunRepository, 'load'> = {
    async load() {
      return {
        sequence: 1,
        view: {
          runId: runId('run-1'),
          activationId: activationId('activation-1'),
          activity: activityName('ci-repair'),
          workflowInstanceId: workflowInstanceId('primary:work-other'),
          orchestrationGroupId: orchestrationGroupId('group-1'),
          attempt: 1,
          status: RunStatus.Succeeded,
          ambiguityAttempts: 0,
          escalated: false,
          startedAt: '2026-08-14T20:00:00.000Z',
        },
      };
    },
  };
  const reactor = createWatchReactor(
    {
      async listWatchMatches() {
        return [
          {
            parent: { workflowInstanceId: workflowInstanceId('primary:work-a') },
            watch: { id: 'ci-repair', workflow: workflowName('ci-repair'), maxPerGroup: 1 },
          },
        ];
      },
      async requestChild(request) {
        requested.push(request.parentWorkflowInstanceId);
        return {};
      },
      async rejectCausalActivation() {
        throw new Error('must not reject; the unrelated match should simply be skipped');
      },
    },
    undefined,
    runs,
  );

  await reactor.react(
    canonicalEvent(
      ExecutionEventType.RunSucceeded,
      'run-succeeded-1',
      { outcome: { kind: 'ci-green' }, finishedAt: '2026-08-14T20:07:41.000Z' },
      runStream(runId('run-1')),
    ),
    {
      commandId: 'react-run-succeeded-1',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-08-14T20:07:41.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );

  expect(requested).toEqual([]);
});

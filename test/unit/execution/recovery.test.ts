import { expect, it } from 'vitest';

import { activationId, activityName } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  RecoveryService,
  runId,
  RunRepository,
  RunStatus,
} from '../../../src/execution/index.js';
import {
  createEventData,
  EventActorKind,
  EventSourceKind,
  type EventJournal,
} from '../../../src/kernel/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { executionFixture } from './support.js';

it('exports RecoveryService for active Run reconciliation', () => {
  expect(RecoveryService).toBeTypeOf('function');
});

it('lists Run views from one journal snapshot without per-Run stream reads', async () => {
  const fixture = executionFixture();
  const backing = new InMemoryEventJournal(fixture.clock);
  const writer = new RunRepository(backing);
  const first = runId('snapshot-first');
  const second = runId('snapshot-second');
  for (const id of [first, second]) {
    await writer.append(id, 0, [
      createEventData({
        eventId: `${id}:started`,
        eventType: ExecutionEventType.RunStarted,
        occurredAt: fixture.clock.now().toISOString(),
        correlationId: 'snapshot',
        causationId: 'snapshot',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        payload: {
          activationId: activationId(`${id}:activation`),
          activity: activityName('long-running'),
          workflowInstanceId: workflowInstanceId(`${id}:workflow`),
          orchestrationGroupId: orchestrationGroupId(`${id}:group`),
          attempt: 1,
          startedAt: fixture.clock.now().toISOString(),
        },
      }),
    ]);
  }
  let readAllCalls = 0;
  let readStreamCalls = 0;
  const recording: EventJournal = {
    appendToStream: backing.appendToStream.bind(backing),
    async readAll(after, limit) {
      readAllCalls += 1;
      return backing.readAll(after, limit);
    },
    async readStream(stream) {
      readStreamCalls += 1;
      return backing.readStream(stream);
    },
    latestGlobalPosition: backing.latestGlobalPosition.bind(backing),
    waitForEventsAfter: backing.waitForEventsAfter.bind(backing),
    changeSignal: backing.changeSignal,
  };

  await expect(new RunRepository(recording).list()).resolves.toMatchObject([
    { runId: first, status: 'started' },
    { runId: second, status: 'started' },
  ]);
  expect(readAllCalls).toBe(1);
  expect(readStreamCalls).toBe(0);
});

it('does not recover a locally tracked Run after its lease duration elapses', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        throw new Error('A local worker must not be inspected as a crashed process');
      },
    },
    fixture.activities,
  );

  await expect(
    recovery.recoverActive('resident-a', fixture.service.isLocallyActive),
  ).resolves.toEqual([]);
  await expect(fixture.service.list()).resolves.toMatchObject([
    { runId: run.runId, status: 'started' },
  ]);
  fixture.complete({ kind: 'done' });
  await fixture.finished('succeeded');
});

it('leaves an unexpired starting Run alone during active recovery', async () => {
  const fixture = executionFixture();
  const id = await appendStartingRun(fixture, 'starting-unexpired', 60_000);
  let inspections = 0;
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        inspections += 1;
        return { kind: 'absent' as const };
      },
    },
    fixture.activities,
  );

  await expect(recovery.recoverActive('resident-b')).resolves.toEqual([]);
  await expect(new RunRepository(fixture.journal).load(id)).resolves.toMatchObject({
    view: { status: RunStatus.Starting },
  });
  expect(inspections).toBe(0);
});

it('fails an expired starting Run without external execution inspection', async () => {
  const fixture = executionFixture();
  const id = await appendStartingRun(fixture, 'starting-expired', -1);
  let inspections = 0;
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        inspections += 1;
        return { kind: 'absent' as const };
      },
    },
    fixture.activities,
  );

  await expect(recovery.recoverActive('resident-b')).resolves.toMatchObject([
    {
      runId: id,
      status: RunStatus.Failed,
      failure: {
        message: 'Preparation was interrupted before execution started',
      },
    },
  ]);
  expect(inspections).toBe(0);
});

it('reconciles definitely completed execution without rerunning it', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  let inspections = 0;
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        inspections++;
        return {
          kind: 'completed' as const,
          result: { transport: 'succeeded' as const, output: '{"kind":"done"}', runner: 'fake' },
        };
      },
    },
    fixture.activities,
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'succeeded',
  });
  expect(inspections).toBe(1);
  expect(fixture.executions).toBe(1);
});

it('continues definitely running execution under a renewed recovery lease', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'running' as const };
      },
    },
    fixture.activities,
    { leaseDurationMs: 30_000, leaseRenewalIntervalMs: 10_000 },
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'started',
    lease: { owner: 'resident-b', expiresAt: '2026-07-30T12:01:30.001Z' },
  });
  expect(fixture.executions).toBe(1);
});

it('reconciles definitely absent execution as failed', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'absent' as const };
      },
    },
    fixture.activities,
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'failed',
    failure: { kind: 'unexpected-execution-failure' },
  });
});

it('fails an unclaimed Run with no external execution instead of refusing recovery', async () => {
  const fixture = executionFixture();
  const id = runId('unclaimed-run');
  await new RunRepository(fixture.journal).append(id, 0, [
    createEventData({
      eventId: 'unclaimed-started',
      eventType: ExecutionEventType.RunStarted,
      occurredAt: fixture.clock.now().toISOString(),
      correlationId: 'recovery',
      causationId: 'test',
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      payload: {
        activationId: activationId('unclaimed-activation'),
        activity: activityName('long-running'),
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        attempt: 1,
        startedAt: fixture.clock.now().toISOString(),
      },
    }),
  ]);
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        throw new Error('Unclaimed Run must not inspect an external execution');
      },
    },
    fixture.activities,
  );

  await expect(recovery.recover(id, 'resident-b')).resolves.toMatchObject({ status: 'failed' });
});

it('records unknown external execution as ambiguous', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'ambiguous',
  });
  expect((await fixture.events()).at(-1)?.event.eventType).toBe(ExecutionEventType.RunAmbiguous);
});

it('does not rerun an escalated ambiguous Run', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
  );

  await recovery.recover(run.runId, 'resident-b');
  await expect(fixture.start('resident-b')).resolves.toMatchObject({ status: 'ambiguous' });
  expect(
    (await new RunRepository(fixture.journal).list()).filter(
      (view) => view.activationId === run.activationId,
    ),
  ).toHaveLength(1);
});

it('keeps unknown executions recoverable until the configured ambiguity bound', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 2 },
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'started',
    ambiguityAttempts: 1,
    escalated: false,
  });
  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'ambiguous',
    ambiguityAttempts: 2,
    escalated: true,
  });
});

it('blocks the owning workflow when ambiguity reaches the configured bound', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const blocked: Array<{ workflowInstanceId: string; reason: string }> = [];
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
    {
      async block(workflowInstanceId, reason) {
        blocked.push({ workflowInstanceId, reason });
      },
    },
  );

  await recovery.recover(run.runId, 'resident-b');
  expect(blocked).toEqual([
    { workflowInstanceId: run.workflowInstanceId, reason: 'run-ambiguous-after-1-attempts' },
  ]);
});

it('accepts an operator resolution only after a Run is escalated', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
  );
  await recovery.recover(run.runId, 'resident-b');

  await expect(
    recovery.resolve(
      run.runId,
      { kind: 'succeeded', outcome: { kind: 'done' } },
      {
        commandId: 'operator-resolution',
        correlationId: 'operator-resolution' as never,
        occurredAt: fixture.clock.now().toISOString(),
        actor: { kind: EventActorKind.Operator, id: 'operator-1' },
      },
    ),
  ).resolves.toMatchObject({ status: 'succeeded', escalated: false, outcome: { kind: 'done' } });
  expect((await fixture.events()).at(-1)?.event.actor).toEqual({
    kind: EventActorKind.Operator,
    id: 'operator-1',
  });
});

it('rejects resolution before escalation and converges concurrent operator resolutions', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
  );
  const context = (id: string) => ({
    commandId: id,
    correlationId: id as never,
    occurredAt: fixture.clock.now().toISOString(),
    actor: { kind: EventActorKind.Operator, id },
  });
  await expect(
    recovery.resolve(run.runId, { kind: 'succeeded', outcome: { kind: 'done' } }, context('early')),
  ).rejects.toThrow(/not escalated/);
  await recovery.recover(run.runId, 'resident-b');
  const results = await Promise.all([
    recovery.resolve(run.runId, { kind: 'succeeded', outcome: { kind: 'done' } }, context('one')),
    recovery.resolve(
      run.runId,
      {
        kind: 'failed',
        failure: { kind: 'unexpected-execution-failure', message: 'operator says failed' },
      },
      context('two'),
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([results[0]!.status, results[0]!.status]);
  expect(
    (await fixture.events()).filter((event) => event.event.actor.kind === EventActorKind.Operator),
  ).toHaveLength(1);
});

it('validates an operator success outcome against the Run Activity', async () => {
  const fixture = executionFixture();
  const run = await fixture.activeRunWithExternalExecution();
  fixture.expireLease();
  const recovery = new RecoveryService(
    fixture.journal,
    fixture.clock,
    {
      async inspect() {
        return { kind: 'unknown' as const, reason: 'runner unavailable' };
      },
    },
    fixture.activities,
    { maxAmbiguityReconciliationAttempts: 1 },
  );
  await recovery.recover(run.runId, 'resident-b');
  await expect(
    recovery.resolve(
      run.runId,
      { kind: 'succeeded', outcome: { kind: 'not-done' } },
      {
        commandId: 'operator-resolution',
        correlationId: 'operator-resolution' as never,
        occurredAt: fixture.clock.now().toISOString(),
        actor: { kind: EventActorKind.Operator, id: 'operator-1' },
      },
    ),
  ).rejects.toThrow(/undeclared activity outcome/i);
});

async function appendStartingRun(
  fixture: ReturnType<typeof executionFixture>,
  id: string,
  leaseOffsetMs: number,
) {
  const currentRunId = runId(id);
  const now = fixture.clock.now();
  await new RunRepository(fixture.journal).append(currentRunId, 0, [
    createEventData({
      eventId: `${id}:preparation`,
      eventType: ExecutionEventType.RunPreparationStarted,
      occurredAt: now.toISOString(),
      correlationId: id,
      causationId: id,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      payload: {
        activationId: activationId(`${id}:activation`),
        activity: activityName('long-running'),
        workflowInstanceId: workflowInstanceId(`${id}:workflow`),
        orchestrationGroupId: orchestrationGroupId(`${id}:group`),
        attempt: 1,
        startedAt: now.toISOString(),
      },
    }),
    createEventData({
      eventId: `${id}:lease`,
      eventType: ExecutionEventType.RunLeaseClaimed,
      occurredAt: now.toISOString(),
      correlationId: id,
      causationId: id,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      payload: {
        owner: 'resident-a',
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseOffsetMs).toISOString(),
      },
    }),
  ]);
  return currentRunId;
}

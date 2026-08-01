import { expect, it } from 'vitest';

import { activationId, activityName } from '../../src-next/activities/index.js';
import {
  ExecutionEventType,
  RecoveryService,
  runId,
  RunRepository,
  runStream,
} from '../../src-next/execution/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../../src-next/kernel/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../src-next/orchestration/index.js';
import { executionFixture } from './support.js';

it('exports RecoveryService for active Run reconciliation', () => {
  expect(RecoveryService).toBeTypeOf('function');
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
    createEventDraft({
      eventId: 'unclaimed-started',
      eventType: ExecutionEventType.RunStarted,
      occurredAt: fixture.clock.now().toISOString(),
      correlationId: 'recovery',
      causationId: 'test',
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream: runStream(id),
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
  );

  await expect(recovery.recover(run.runId, 'resident-b')).resolves.toMatchObject({
    status: 'ambiguous',
  });
  expect((await fixture.events()).at(-1)?.eventType).toBe(ExecutionEventType.RunAmbiguous);
});

it('never automatically retries an ambiguous Run', async () => {
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
  );

  await recovery.recover(run.runId, 'resident-b');
  await expect(fixture.start('resident-b')).resolves.toMatchObject({ status: 'ambiguous' });
  expect(
    (await new RunRepository(fixture.journal).list()).filter(
      (view) => view.activationId === run.activationId,
    ),
  ).toHaveLength(1);
});

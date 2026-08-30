import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../../src/activities/index.js';
import {
  ExecutionEventType,
  RunRepository,
  runId,
  runStream,
} from '../../../../src/execution/index.js';
import { applyWatchGateVerdictSignal } from '../../../../src/integrations/github/application/inbound-watch-gate-signals.js';
import { createEventData } from '../../../../src/kernel/index.js';
import { workflowName } from '../../../../src/orchestration/index.js';
import { TestWorld } from '../../../e2e/support/world.js';

it('accepts a DONE marker cross-checked against a real watch-child run', async () => {
  const fixture = await waitingWatchGate();

  await applyWatchGateVerdictSignal({
    event: commentEvent(marker(fixture.run.runId, 'DONE')),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'completed',
  );
});

it('ignores a forged marker whose outcome does not match the durable run outcome', async () => {
  const fixture = await waitingWatchGate();

  await applyWatchGateVerdictSignal({
    event: commentEvent(marker(fixture.run.runId, 'REJECTED')),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
});

it('ignores a marker for a real but nonterminal watch-child run', async () => {
  const fixture = await waitingWatchGate();
  const activeRunId = await appendNonterminalChildRun(fixture);

  await applyWatchGateVerdictSignal({
    event: commentEvent(marker(activeRunId, 'DONE')),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
});

it('finds a valid wake marker after an unrelated JSON fence', async () => {
  const fixture = await waitingWatchGate();

  await applyWatchGateVerdictSignal({
    event: commentEvent(
      ['```json', '{"unrelated":true}', '```', marker(fixture.run.runId, 'DONE')].join('\n'),
    ),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'completed',
  );
});

it('ignores a marker with an unknown runId', async () => {
  const fixture = await waitingWatchGate();

  await applyWatchGateVerdictSignal({
    event: commentEvent(marker('run-does-not-exist', 'DONE')),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
});

it('ignores a marker whose outcome is FAILED', async () => {
  const fixture = await waitingWatchGate();

  await applyWatchGateVerdictSignal({
    event: commentEvent(marker(fixture.run.runId, 'FAILED')),
    runs: new RunRepository(fixture.world.journal),
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
});

it('ignores a malformed marker and a comment with no marker', async () => {
  const fixture = await waitingWatchGate();
  const runs = new RunRepository(fixture.world.journal);

  await applyWatchGateVerdictSignal({
    event: commentEvent('```json\n{"wake":{"watchGateVerdict":{"runId": 7}}}\n```'),
    runs,
    orchestration: fixture.world.orchestration,
  });
  await applyWatchGateVerdictSignal({
    event: commentEvent('ordinary review discussion'),
    runs,
    orchestration: fixture.world.orchestration,
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
});

async function waitingWatchGate() {
  const world = new TestWorld();
  world.registerActivity(activity('parent-work'));
  world.registerActivity(activity('pr-review'));
  world.configureWorkflow('pr-review', {
    stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' } } } },
  });
  world.configureWorkflow('parent', {
    stages: {
      work: {
        activity: 'parent-work',
        with: {},
        on: { done: { then: 'done', watchGates: ['pr-review'] } },
      },
    },
    watches: [
      {
        id: 'pr-review',
        while: { stages: ['work'], statuses: ['waiting'] },
        on: { events: ['pr-review.requested'] },
        workflow: 'pr-review',
        maxPerGroup: 1,
      },
    ],
  });
  const work = await world.createWork({ objective: 'inbound verdict' });
  const parent = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('parent'),
  });
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  await world.triggerWatch('pr-review.requested', 'pr-review-trigger');
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  const child = (await world.orchestration.listAll()).find(
    (workflow) => workflow.parentWorkflowInstanceId === parent.workflowInstanceId,
  );
  if (child === undefined) throw new Error('Expected a watch child workflow');
  const run = (await world.viewRuns()).find(
    (candidate) => candidate.workflowInstanceId === child.workflowInstanceId,
  );
  if (run === undefined) throw new Error('Expected a real child run');
  return { world, parent, child, run };
}

async function appendNonterminalChildRun(fixture: Awaited<ReturnType<typeof waitingWatchGate>>) {
  const id = runId('run-active-watch-child');
  await fixture.world.journal.appendToStream(runStream(id), 0, [
    createEventData({
      eventId: 'execution:run-active-watch-child:started',
      eventType: ExecutionEventType.RunStarted,
      occurredAt: '2026-08-08T00:00:00.000Z',
      correlationId: 'test:inbound-watch-gate',
      causationId: 'test:inbound-watch-gate',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {
        activationId: 'activation-active-watch-child',
        activity: 'pr-review',
        workflowInstanceId: fixture.child.workflowInstanceId,
        orchestrationGroupId: fixture.child.orchestrationGroupId,
        attempt: 1,
        startedAt: '2026-08-08T00:00:00.000Z',
      },
    }) as never,
  ]);
  return id;
}

function activity(name: string) {
  return {
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'] as const,
    resources: [],
    executionKind: 'deterministic' as const,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  };
}

function marker(runId: string, outcome: string): string {
  return [
    '```json',
    JSON.stringify({ wake: { watchGateVerdict: { runId, outcome } } }),
    '```',
  ].join('\n');
}

function commentEvent(body: string) {
  return {
    event: {
      eventId: 'github:comment:1',
      eventType: 'integration.github.comment-observed',
      schemaVersion: 1,
      occurredAt: '2026-08-08T00:00:00.000Z',
      correlationId: 'github:issue:1',
      causationId: 'github:comment:1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      payload: {
        reviewKind: 'issue',
        externalKey: 'github:atolis-hq/wake#1',
        body,
        revision: '2026-08-08T00:00:00.000Z',
        actor: { id: 'wake-bot', kind: 'bot' },
        raw: { id: 1 },
      },
    },
    stream: { kind: 'integration', id: 'github' },
    recordedAt: '2026-08-08T00:00:00.000Z',
    sequence: 1,
    globalPosition: 1,
  } as never;
}

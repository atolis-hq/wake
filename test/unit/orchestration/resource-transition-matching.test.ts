import { correlationId, type CommandContext } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityEventType,
  activityName,
  ActivityRegistry,
  PullRequestState,
} from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationService,
  OrchestrationEventType,
  WorkflowStatus,
} from '../../../src/orchestration/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId, workId } from '../../support/identities.js';

const prStream = resourceStream(resId('1'));

async function waitingService() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const baseContext: CommandContext = {
    commandId: 'create-work',
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-08-15T12:00:00.000Z',
    actor: { kind: 'operator', id: 'owner' },
  };
  await work.create({ workItemId: workId('1'), objective: 'ship' }, baseContext);
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  const definition = compileWorkflow(
    'main',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: {
            done: {
              then: 'after-merge',
              resourceTransitions: [
                {
                  events: [ActivityEventType.PrStateChanged],
                  where: { state: PullRequestState.Merged },
                  then: 'after-merge',
                },
                {
                  events: [ActivityEventType.PrChecksChanged],
                  where: { checks: 'failing' },
                  then: 'implement',
                },
              ],
            },
          },
        },
        'after-merge': {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done' } },
        },
      },
    },
    registry,
  );
  const service = createOrchestrationService(journal, work, { main: definition });
  const started = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('main'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...baseContext, commandId: 'start' },
  );
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: started.workflowInstanceId,
      activationId: started.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...baseContext, commandId: 'run-1' },
  );
  expect(waiting.status).toBe(WorkflowStatus.Waiting);
  expect(waiting.waitingFor?.resourceTransitions).toHaveLength(2);
  const waitStarted = (await journal.readAll(0)).find(
    (event) =>
      event.event.eventType === OrchestrationEventType.SignalWaitStarted &&
      event.stream.id === waiting.workflowInstanceId,
  )!;
  return { journal, service, baseContext, instance: waiting, waitStarted };
}

it('matches a waiting instance whose transition declares this event type', async () => {
  const { service, instance } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );

  const matches = await service.listResourceTransitionMatches(mergedFact);

  expect(matches).toHaveLength(1);
  expect(matches[0]!.workflowInstanceId).toBe(instance.workflowInstanceId);
  expect(matches[0]!.transitions).toHaveLength(1);
});

it('does not match when the where predicate disagrees with the payload', async () => {
  const { service } = await waitingService();
  const closedFact = eventEnvelope(ActivityEventType.PrStateChanged, { state: 'closed' }, prStream);

  expect(await service.listResourceTransitionMatches(closedFact)).toStrictEqual([]);
});

it('returns every transition of the named instance for a signal-wait-started trigger', async () => {
  const { service, waitStarted } = await waitingService();

  const matches = await service.listResourceTransitionMatches(waitStarted);

  expect(matches).toHaveLength(1);
  expect(matches[0]!.transitions).toHaveLength(2);
});

it('ignores instances that are not waiting', async () => {
  const { service, instance, baseContext } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );
  const matches = await service.listResourceTransitionMatches(mergedFact);
  await service.applyResourceTransition(
    instance.workflowInstanceId,
    matches[0]!.transitions[0]!.target,
    mergedFact.event.eventId,
    { ...baseContext, commandId: 'apply-1' },
  );

  expect(await service.listResourceTransitionMatches(mergedFact)).toStrictEqual([]);
});

// Covers "no re-fire once Waiting has already been left" — NOT duplicate-evidence
// protection. By the second call `loaded.view.waitingFor` is already undefined
// (the first call's decision already moved the instance on), so
// acceptResourceTransition's own null-waitingFor guard short-circuits before
// decideSignal ever runs. See the concurrent test below for the case that
// actually exercises duplicate evidence arriving while still Waiting.
it('does not re-fire a second sequential apply once the instance has left Waiting', async () => {
  const { journal, service, instance, baseContext } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );
  const matches = await service.listResourceTransitionMatches(mergedFact);
  const target = matches[0]!.transitions[0]!.target;

  const first = await service.applyResourceTransition(
    instance.workflowInstanceId,
    target,
    mergedFact.event.eventId,
    { ...baseContext, commandId: 'apply-1' },
  );
  const afterFirst = (await journal.readAll(0)).length;
  const second = await service.applyResourceTransition(
    instance.workflowInstanceId,
    target,
    mergedFact.event.eventId,
    { ...baseContext, commandId: 'apply-2' },
  );
  const afterSecond = (await journal.readAll(0)).length;

  expect(first?.currentStage).toBe('after-merge');
  expect(afterSecond).toBe(afterFirst);
  expect(second).toStrictEqual(first);
});

// The genuine duplicate-evidence race: both calls load the instance while it
// is still Waiting (neither has appended yet), so signal-policy's
// acceptedSignalIds guard cannot see the other call — it only protects a
// reload after a prior apply has already landed (see the sequential test
// above). Same command context: acceptResourceTransition derives the same
// causationId/eventId for both, and the journal's appendToStream() recognises the
// second draft as already-recorded instead of re-checking the expected
// sequence. Different command contexts (below) derive different eventIds,
// so the second append genuinely conflicts on sequence — that's what
// acceptResourceTransition's local catch-reload-check guard covers.
it('two overlapping applies of the same confirmed evidence, same command context, produce exactly one state change', async () => {
  const { journal, service, instance, baseContext } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );
  const matches = await service.listResourceTransitionMatches(mergedFact);
  const target = matches[0]!.transitions[0]!.target;
  const context = { ...baseContext, commandId: 'apply-concurrent' };

  const [first, second] = await Promise.all([
    service.applyResourceTransition(
      instance.workflowInstanceId,
      target,
      mergedFact.event.eventId,
      context,
    ),
    service.applyResourceTransition(
      instance.workflowInstanceId,
      target,
      mergedFact.event.eventId,
      context,
    ),
  ]);

  expect(first?.currentStage).toBe('after-merge');
  expect(second?.currentStage).toBe('after-merge');
  const stageEnteredCount = (await journal.readAll(0)).filter(
    (event) =>
      event.event.eventType === OrchestrationEventType.StageEntered &&
      event.stream.id === instance.workflowInstanceId &&
      (event.event.payload as { stage?: string }).stage === 'after-merge',
  ).length;
  expect(stageEnteredCount).toBe(1);
});

it('two overlapping applies of the same confirmed evidence, different command contexts, produce exactly one state change', async () => {
  const { journal, service, instance, baseContext } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );
  const matches = await service.listResourceTransitionMatches(mergedFact);
  const target = matches[0]!.transitions[0]!.target;

  const [first, second] = await Promise.all([
    service.applyResourceTransition(instance.workflowInstanceId, target, mergedFact.event.eventId, {
      ...baseContext,
      commandId: 'apply-concurrent-a',
    }),
    service.applyResourceTransition(instance.workflowInstanceId, target, mergedFact.event.eventId, {
      ...baseContext,
      commandId: 'apply-concurrent-b',
    }),
  ]);

  expect(first?.currentStage).toBe('after-merge');
  expect(second?.currentStage).toBe('after-merge');
  const stageEnteredCount = (await journal.readAll(0)).filter(
    (event) =>
      event.event.eventType === OrchestrationEventType.StageEntered &&
      event.stream.id === instance.workflowInstanceId &&
      (event.event.payload as { stage?: string }).stage === 'after-merge',
  ).length;
  expect(stageEnteredCount).toBe(1);
});

import { expect, it, vi } from 'vitest';
import { AgentRunPublicationReactor } from '../../src/integrations/application/agent-run-publication-reactor.js';

it('does not publish from a raw execution completion before orchestration resolves it', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readAll: async () => [
        {
          eventType: 'execution.run-succeeded',
          stream: { id: 'run-1' },
          recordedAt: '2026-08-08T00:01:00.000Z',
          eventId: 'run-1:succeeded',
          correlationId: 'correlation-1',
          globalPosition: 1,
        },
      ],
    },
    checkpoints: { load: async () => 0, save: async () => undefined },
    runs: {},
    resources: {},
    orchestration: {},
  } as never);
  const publish = vi.fn();
  (reactor as never as { publish: typeof publish }).publish = publish;

  await reactor.runOnce();

  expect(publish).not.toHaveBeenCalled();
});

it('publishes a failed Run only after orchestration records its execution failure', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readAll: async () => [
        {
          eventType: 'orchestration.activity-execution-failed',
          stream: { id: 'workflow-1' },
          payload: { activationId: 'activation-1', runId: 'run-failed', reason: 'runner exited 1' },
          recordedAt: '2026-08-08T00:01:00.000Z',
          eventId: 'workflow-1:execution-failed',
          correlationId: 'correlation-1',
          globalPosition: 1,
        },
      ],
    },
    checkpoints: { load: async () => 0, save: async () => undefined },
    runs: { load: async () => ({ view: { runId: 'run-failed' } }) },
    resources: {},
    orchestration: {},
  } as never);
  const publish = vi.fn();
  (reactor as never as { publish: typeof publish }).publish = publish;

  await reactor.runOnce();

  expect(publish).toHaveBeenCalledWith(
    'run-failed',
    '2026-08-08T00:01:00.000Z',
    'workflow-1:execution-failed',
    'correlation-1',
  );
});

it('uses the stage immediately preceding the run activation rather than a later advanced stage', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [
        { eventType: 'orchestration.stage-entered', payload: { stage: 'refine' } },
        {
          eventType: 'orchestration.activity-requested',
          payload: { activationId: 'activation-1' },
        },
        { eventType: 'orchestration.stage-entered', payload: { stage: 'implement' } },
      ],
    },
    checkpoints: {},
    runs: {},
    resources: {},
    orchestration: {},
  } as never);
  await expect(
    (
      reactor as never as {
        stageForActivation: (workflow: string, activation: string) => Promise<string | undefined>;
      }
    ).stageForActivation('workflow-1', 'activation-1'),
  ).resolves.toBe('refine');
});

it('attaches watchGateVerdict to a rejected watch child run whose parent waits on that watch', async () => {
  const published = await publishWatchChildOutcome({ outcome: 'REJECTED' });

  expect(published.payload.report).toMatchObject({
    outcome: 'REJECTED',
    watchGateVerdict: { runId: 'run-1' },
  });
});

it('does not attach watchGateVerdict to a failed watch child run', async () => {
  const published = await publishWatchChildOutcome({ outcome: 'FAILED' });

  expect(published.payload.report).toMatchObject({ outcome: 'FAILED' });
  expect(published.payload.report.watchGateVerdict).toBeUndefined();
});

it('attaches watchGateVerdict to a completed watch child run whose parent waits on that watch', async () => {
  const published = await publishWatchChildOutcome({ outcome: 'DONE' });

  expect(published.payload.report).toMatchObject({
    outcome: 'DONE',
    watchGateVerdict: { runId: 'run-1' },
  });
});

it('does not attach watchGateVerdict to a blocked watch child run', async () => {
  const published = await publishWatchChildOutcome({ outcome: 'BLOCKED' });

  expect(published.payload.report).toMatchObject({ outcome: 'BLOCKED' });
  expect(published.payload.report.watchGateVerdict).toBeUndefined();
});

it('does not attach watchGateVerdict when the parent waits on a different watch', async () => {
  const published = await publishWatchChildOutcome({
    outcome: 'DONE',
    parentWatchId: 'plan-review',
  });

  expect(published.payload.report.watchGateVerdict).toBeUndefined();
});

it('does not attach watchGateVerdict when the watch child has no parent', async () => {
  const published = await publishWatchChildOutcome({ outcome: 'REJECTED', hasParent: false });

  expect(published.payload.report.watchGateVerdict).toBeUndefined();
});

it('preserves awaitingApproval for the approved signal', async () => {
  const published = await publishWatchChildOutcome({
    outcome: 'DONE',
    childWaitingSignal: 'approved',
  });

  expect(published.payload.report.awaitingApproval).toBe(true);
});

it('adds awaitingApproval for a watchGate signal', async () => {
  const published = await publishWatchChildOutcome({
    outcome: 'DONE',
    childWaitingSignal: 'orchestration.watch-gate-verdict',
  });

  expect(published.payload.report.awaitingApproval).toBe(true);
});

it.each([
  ['primary', 'resource-primary'],
  ['issue', 'resource-issue'],
  ['pull-request', 'resource-pr'],
] as const)('routes a %s reply to the requested resource kind', async (target, resourceId) => {
  const published = await publishWithReplyTarget(target);
  expect(published.payload.resourceId).toBe(resourceId);
});

it('suppresses a reply when its configured target is none', async () => {
  await expect(publishWithReplyTarget('none')).resolves.toBeUndefined();
});

it('falls back to the primary correlation when the requested kind is absent', async () => {
  const published = await publishWithReplyTarget('pull-request', false);
  expect(published.payload.resourceId).toBe('resource-primary');
});

async function publishWatchChildOutcome(input: {
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  readonly parentWatchId?: string;
  readonly hasParent?: boolean;
  readonly childWaitingSignal?: string;
}) {
  const appended: unknown[][] = [];
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [
        { eventType: 'orchestration.stage-entered', payload: { stage: 'review' } },
        {
          eventType: 'orchestration.activity-requested',
          payload: { activationId: 'activation-1' },
        },
      ],
      append: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(events);
      },
    },
    checkpoints: {},
    runs: {
      load: async () => ({
        view: {
          runId: 'run-1',
          activity: 'agent',
          workflowInstanceId: 'child-1',
          activationId: 'activation-1',
          startedAt: '2026-08-08T00:00:00.000Z',
          finishedAt: '2026-08-08T00:01:00.000Z',
          agent: { outcome: input.outcome, displayBody: 'Child completed.', metadata: {} },
        },
      }),
    },
    resources: {
      correlationsForWork: async () => [{ role: 'primary', resourceId: 'resource-1' }],
    },
    orchestration: {
      listAll: async () => [
        {
          workflowInstanceId: 'child-1',
          workItemId: 'work-1',
          ...(input.hasParent === false ? {} : { parentWorkflowInstanceId: 'parent-1' }),
          watchId: 'pr-review',
          ...(input.childWaitingSignal === undefined
            ? {}
            : { waitingFor: { signalKind: input.childWaitingSignal } }),
        },
        {
          workflowInstanceId: 'parent-1',
          workItemId: 'work-1',
          waitingFor: {
            signalKind: 'orchestration.watch-gate-verdict',
            from: [{ kind: 'watch', watch: input.parentWatchId ?? 'pr-review' }],
          },
        },
      ],
    },
  } as never);
  await (
    reactor as never as {
      publish: (
        id: string,
        occurredAt: string,
        causationId: string,
        correlationId: string,
      ) => Promise<void>;
    }
  ).publish('run-1', '2026-08-08T00:01:00.000Z', 'event-1', 'correlation-1');
  return (appended[0] as Array<{ payload: { report: Record<string, unknown> } }>)[0]!;
}

async function publishWithReplyTarget(
  target: 'primary' | 'issue' | 'pull-request' | 'none',
  includePullRequest = true,
) {
  const appended: unknown[][] = [];
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [],
      append: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(events);
      },
    },
    checkpoints: {},
    runs: {
      load: async () => ({
        view: {
          runId: 'run-1',
          activity: 'agent',
          workflowInstanceId: 'workflow-1',
          activationId: 'activation-1',
          startedAt: '2026-08-08T00:00:00.000Z',
          finishedAt: '2026-08-08T00:01:00.000Z',
          agent: { outcome: 'DONE', displayBody: 'Completed.', metadata: {} },
        },
      }),
    },
    resources: {
      correlationsForWork: async () => [
        { role: 'primary', resourceId: 'resource-primary' },
        { role: 'secondary', resourceId: 'resource-issue' },
        ...(includePullRequest ? [{ role: 'secondary', resourceId: 'resource-pr' }] : []),
      ],
      get: async (id: string) => ({
        resourceId: id,
        kind:
          id === 'resource-issue'
            ? 'issue'
            : id === 'resource-pr'
              ? 'pull-request'
              : 'repository',
      }),
    },
    orchestration: {
      listAll: async () => [{ workflowInstanceId: 'workflow-1', workItemId: 'work-1' }],
    },
    replies: { rules: [{ match: { stage: ['review'] }, matchMode: 'any', target }], default: 'primary' },
  } as never);
  await (
    reactor as never as {
      publish: (
        id: string,
        occurredAt: string,
        causationId: string,
        correlationId: string,
      ) => Promise<void>;
    }
  ).publish('run-1', '2026-08-08T00:01:00.000Z', 'event-1', 'correlation-1');
  if (target === 'none') return undefined;
  return (appended[0] as Array<{ payload: { resourceId: string } }>)[0]!;
}

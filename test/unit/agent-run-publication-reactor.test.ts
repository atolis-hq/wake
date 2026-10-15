import { expect, it, vi } from 'vitest';
import { parseAgentRunnerResponse } from '../../src/execution/infrastructure/agent-runner-adapter.js';
import { AgentRunPublicationReactor } from '../../src/integrations/application/agent-run-publication-reactor.js';
import { formatAgentRunComment } from '../../src/integrations/github/application/agent-run-comment.js';
import { OrchestrationEventType, WorkflowStatus } from '../../src/orchestration/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const workflowStream = { kind: 'workflow-instance', id: 'workflow-1' } as const;

function workflowHistory(stage = 'review') {
  return [
    eventEnvelope('orchestration.stage-entered', { stage }, workflowStream, 1),
    eventEnvelope(
      'orchestration.activity-requested',
      { activationId: 'activation-1', ordinal: 1, activity: 'agent', input: {} },
      workflowStream,
      2,
    ),
  ];
}

it('exposes its stable event processor identity', () => {
  const reactor = new AgentRunPublicationReactor({ journal: {} } as never);

  expect(reactor).toMatchObject({
    processor: {
      consumer: 'reactor:agent-run-publication',
      name: 'agent-run-publication',
      owner: 'integrations',
    },
  });
});

it('skips facts outside the workflow orchestration namespace', () => {
  const reactor = new AgentRunPublicationReactor({ journal: {} } as never);

  expect(
    (reactor.processor as never as { select: (event: unknown) => unknown }).select({
      ...eventEnvelope('execution.run-succeeded', {}, { kind: 'run', id: 'run-1' }),
    }),
  ).toBeNull();
});

it('does not publish from a raw execution completion before orchestration resolves it', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {},
    runs: {},
    resources: {},
    orchestration: {},
  } as never);
  const publish = vi.fn();
  (reactor as never as { publish: typeof publish }).publish = publish;

  expect(
    (reactor.processor as never as { select: (event: unknown) => unknown }).select({
      ...eventEnvelope('execution.run-succeeded', {}, { kind: 'run', id: 'run-1' }),
    }),
  ).toBeNull();

  expect(publish).not.toHaveBeenCalled();
});

it('does not publish a terminal agent reply when canonical conversation recording fails', async () => {
  const appended: unknown[][] = [];
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => workflowHistory(),
      appendToStream: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(events);
      },
    },
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
        { role: 'primary', resourceId: 'resource-00000000000000000000000001' },
      ],
    },
    orchestration: {
      listAll: async () => [
        { workflowInstanceId: 'workflow-1', workItemId: 'work-00000000000000000000000001' },
      ],
    },
    conversations: {
      createForWorkItem: async () => Promise.reject(new Error('conversation unavailable')),
    },
    replies: {
      rules: [{ match: { stage: ['review'] }, matchMode: 'any', target: 'primary' }],
      default: 'primary',
    },
  } as never);

  await expect(
    (
      reactor as never as {
        publish: (
          id: string,
          occurredAt: string,
          causationId: string,
          correlationId: string,
        ) => Promise<void>;
      }
    ).publish('run-1', '2026-08-08T00:01:00.000Z', 'cause-1', 'correlation-1'),
  ).rejects.toThrow('conversation unavailable');

  expect(appended).toHaveLength(0);
});

it('publishes a failed Run only after orchestration records its execution failure', async () => {
  const failure = eventEnvelope(
    'orchestration.activity-execution-failed',
    { activationId: 'activation-1', runId: 'run-failed', reason: 'runner exited 1' },
    workflowStream,
  );
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readAll: async () => [failure],
    },
    runs: { load: async () => ({ view: { runId: 'run-failed' } }) },
    resources: {},
    orchestration: {},
  } as never);
  const publish = vi.fn();
  (reactor as never as { publish: typeof publish }).publish = publish;

  await reactor.react(failure as never);

  expect(publish).toHaveBeenCalledWith(
    'run-failed',
    failure.recordedAt,
    failure.event.eventId,
    failure.event.correlationId,
  );
});

it('uses the stage immediately preceding the run activation rather than a later advanced stage', async () => {
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [
        ...workflowHistory('refine'),
        eventEnvelope('orchestration.stage-entered', { stage: 'implement' }, workflowStream, 3),
      ],
    },
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
  if (published === undefined) throw new Error('expected a publication');
  expect(published.payload.resourceId).toBe(resourceId);
});

it('suppresses a reply when its configured target is none', async () => {
  await expect(publishWithReplyTarget('none')).resolves.toBeUndefined();
});

it('falls back to the primary correlation when the requested kind is absent', async () => {
  const published = await publishWithReplyTarget('pull-request', false);
  if (published === undefined) throw new Error('expected a publication');
  expect(published.payload.resourceId).toBe('resource-primary');
});

async function publishWatchChildOutcome(input: {
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  readonly output?: string;
  readonly parentWatchId?: string;
  readonly hasParent?: boolean;
  readonly childWaitingSignal?: string;
}) {
  const appended: unknown[][] = [];
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => workflowHistory(),
      appendToStream: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(events);
      },
    },
    runs: {
      load: async () => ({
        view: {
          runId: 'run-1',
          activity: 'agent',
          workflowInstanceId: 'child-1',
          activationId: 'activation-1',
          startedAt: '2026-08-08T00:00:00.000Z',
          finishedAt: '2026-08-08T00:01:00.000Z',
          agent:
            input.output === undefined
              ? { outcome: input.outcome, displayBody: 'Child completed.', metadata: {} }
              : parseAgentRunnerResponse({
                  transport: 'succeeded',
                  output: input.output,
                  runner: 'codex',
                }),
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
      readStream: async () => workflowHistory(),
      appendToStream: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(events);
      },
    },
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
          id === 'resource-issue' ? 'issue' : id === 'resource-pr' ? 'pull-request' : 'repository',
      }),
    },
    orchestration: {
      listAll: async () => [{ workflowInstanceId: 'workflow-1', workItemId: 'work-1' }],
    },
    replies: {
      rules: [{ match: { stage: ['review'] }, matchMode: 'any', target }],
      default: 'primary',
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
  if (target === 'none') return undefined;
  return (appended[0] as Array<{ payload: { resourceId: string } }>)[0]!;
}

it.each(['DONE', 'REJECTED'] as const)(
  'publishes a %s marker as a watch verdict and comment',
  async (outcome) => {
    const published = await publishWatchChildOutcome({
      outcome,
      output: 'Review complete.\n[[STATUS: ' + outcome + ']]',
    });
    expect(published.payload.report).toMatchObject({
      outcome,
      displayBody: 'Review complete.',
      watchGateVerdict: { runId: 'run-1' },
    });
    const comment = formatAgentRunComment(published.payload.report as never);
    expect(comment).toContain(outcome === 'DONE' ? 'Done' : 'Changes Requested');
    expect(comment).not.toContain('[[STATUS:');
    expect(comment).not.toContain('Reply on this thread to continue');
  },
);

async function reactToMergeWait(
  workflow: Record<string, unknown>,
  staleSignalKind?: string,
): Promise<Array<{ payload: { body: string } }>> {
  const appended: Array<{ payload: { body: string } }> = [];
  const reactor = new AgentRunPublicationReactor({
    journal: {
      readStream: async () => [],
      appendToStream: async (_stream: unknown, _sequence: number, events: unknown[]) => {
        appended.push(...(events as Array<{ payload: { body: string } }>));
      },
    },
    resources: { correlationsForWork: async () => [{ role: 'primary', resourceId: 'resource-1' }] },
    orchestration: {
      listAll: async () => [
        {
          workflowInstanceId: 'workflow-1',
          workItemId: 'work-1',
          status: WorkflowStatus.Waiting,
          currentStage: 'merge',
          pendingActivation: { activationId: 'activation-1', activity: 'pr.merge' },
          ...workflow,
        },
      ],
    },
  } as never);
  await reactor.react({
    stream: { kind: 'workflow-instance', id: 'workflow-1' },
    recordedAt: '2026-10-14T00:00:00.000Z',
    event: {
      eventType: OrchestrationEventType.SignalWaitStarted,
      eventId: 'wait-1',
      correlationId: 'correlation-1',
      payload: {
        signalKind:
          staleSignalKind ??
          (workflow.waitingFor as { signalKind: string } | undefined)?.signalKind,
      },
    },
  } as never);
  return appended;
}

it('posts only /approved when the merge stage starts a default approval wait', async () => {
  const [intent] = await reactToMergeWait({ waitingFor: { signalKind: 'approved' } });
  expect(intent?.payload.body).toContain('Awaiting approval');
  expect(intent?.payload.body).toContain('/approved');
  expect(intent?.payload.body).not.toContain('/changes');
  expect(intent?.payload.body).not.toContain('/ask');
});

it('posts provider-merge guidance for a policy-denied manual merge wait', async () => {
  const [intent] = await reactToMergeWait({
    waitingFor: { signalKind: 'blocked' },
    lastOutcome: { kind: 'blocked', data: { reason: 'blocked-path-changed' } },
  });
  expect(intent?.payload.body).toContain('Awaiting merge');
  expect(intent?.payload.body).not.toContain('/approved');
  expect(intent?.payload.body).not.toContain('/changes');
});

it('ignores a replayed wait event whose signal is no longer the current wait', async () => {
  expect(await reactToMergeWait({ waitingFor: { signalKind: 'approved' } }, 'blocked')).toEqual([]);
});

it('posts nothing for a merge-stage wait with an unrelated signal', async () => {
  expect(await reactToMergeWait({ waitingFor: { signalKind: 'other' } })).toEqual([]);
});

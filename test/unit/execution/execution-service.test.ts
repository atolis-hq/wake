import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { activationId } from '../../../src/activities/contracts/identifiers.js';
import {
  ActivityExecutionKind,
  activityName,
  ActivityRegistry,
  type ActivationId,
  type ActivityName,
  type ActivityOrchestrationGroupId,
  type ActivityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import {
  createExecutionService,
  ExecutionFailureCode,
  type ExecutionActivation,
  type ExecutionAttemptContext,
  type WorkspaceProvider,
} from '../../../src/execution/index.js';
import { type EventJournal } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import {} from '../../../src/work/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

function setup(workspace?: WorkspaceProvider, journal?: EventJournal) {
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({ prompt: z.string() }).strict(),
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
  const eventJournal = journal ?? new InMemoryEventJournal(new FakeClock());
  const service = createExecutionService(
    eventJournal,
    registry,
    { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
    {
      clock: new FakeClock(),
      ids: new SequentialIds(),
      ...(workspace === undefined ? {} : { workspaces: workspace }),
    },
  );
  return { service, journal: eventJournal };
}

const activation = {
  activationId: activationId('workflow-1:activity:1'),
  ordinal: 1,
  activity: activityName('implement'),
  input: { prompt: 'ship' },
  execution: { workspace: 'none' as const },
  status: 'pending' as const,
};
const context = {
  workItemId: workId('1'),
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  resources: [],
};

describe('ExecutionService', () => {
  it('creates one Run and records a validated outcome separately', async () => {
    const run = await setup().service.attempt(activation, context);
    expect(run).toMatchObject({
      activationId: activation.activationId,
      activity: activation.activity,
      workflowInstanceId: context.workflowInstanceId,
      orchestrationGroupId: context.orchestrationGroupId,
      attempt: 1,
      status: 'succeeded',
      outcome: { kind: 'done' },
    });
  });
  it('validates input before run.started', async () => {
    await expect(setup().service.attempt({ ...activation, input: {} }, context)).rejects.toThrow(
      /input invalid/,
    );
  });
  it('does not allocate a workspace for none', async () => {
    let calls = 0;
    await setup({
      async acquire() {
        calls++;
        throw new Error('unexpected');
      },
    }).service.attempt(activation, context);
    expect(calls).toBe(0);
  });

  it('passes the newly allocated Run ID to workspace acquisition', async () => {
    let acquiredRunId: string | undefined;
    const fixture = setup({
      async acquire(request) {
        acquiredRunId = request.runId;
        return {
          workspaceId: 'workspace-1',
          path: '/workspace-1',
          mode: 'read-only',
          async release() {},
        };
      },
    });

    await fixture.service.attempt(
      { ...activation, execution: { workspace: 'read-only' } },
      {
        ...context,
        resources: [
          {
            resourceId: resId('repo'),
            kind: BuiltInResourceKind.Repository,
            externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
            capabilities: [],
          },
        ],
      },
    );

    expect(acquiredRunId).toBe('run-1');
  });

  it('records workspace cleanup failure without failing a completed run', async () => {
    const fixture = setup({
      async acquire() {
        return {
          workspaceId: 'workspace-1',
          path: '/workspace-1',
          mode: 'read-only',
          async release() {
            throw new Error('EACCES: workspace still in use');
          },
        };
      },
    });
    const run = await fixture.service.attempt(
      { ...activation, execution: { workspace: 'read-only' } },
      {
        ...context,
        resources: [
          {
            resourceId: resId('repo'),
            kind: BuiltInResourceKind.Repository,
            externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
            capabilities: [],
          },
        ],
      },
    );

    expect(run.status).toBe('succeeded');
    expect((await fixture.journal.readAll(0)).map((event) => event.eventType)).toContain(
      'execution.workspace-cleanup-failed',
    );
  });

  it('releases an allocated workspace when persisting run start is interrupted, then allows retry', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    let failStartOnce = true;
    const interruptedJournal: EventJournal = {
      async append(stream, expectedSequence, events) {
        if (failStartOnce && events.some((event) => event.eventType === 'execution.run-started')) {
          failStartOnce = false;
          throw new Error('run start append interrupted');
        }
        return base.append(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      readLatest: base.readLatest?.bind(base),
    };
    let acquired = 0;
    let released = 0;
    const fixture = setup(
      {
        async acquire() {
          acquired += 1;
          return {
            workspaceId: `workspace-${acquired}`,
            path: `/workspace-${acquired}`,
            mode: 'read-only',
            async release() {
              released += 1;
            },
          };
        },
      },
      interruptedJournal,
    );
    const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
    const workspaceContext = {
      ...context,
      resources: [
        {
          resourceId: resId('repo'),
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
          capabilities: [],
        },
      ],
    };

    await expect(fixture.service.attempt(workspaceActivation, workspaceContext)).rejects.toThrow(
      'run start append interrupted',
    );
    expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });

    await expect(
      fixture.service.attempt(workspaceActivation, workspaceContext),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect({ acquired, released }).toEqual({ acquired: 2, released: 2 });
  });
  it('rejects an unregistered execution runner pool', async () => {
    await expect(
      setup().service.attempt({ ...activation, execution: { runnerPool: 'premium' } }, context),
    ).rejects.toThrow(/runner pool/);
  });

  it('preserves valid owner-specific output and rejects invalid owner output end to end', async () => {
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('score'),
      inputSchema: z.object({ value: z.number() }).strict(),
      outcomeSchema: z
        .object({
          kind: z.literal('scored'),
          data: z.object({ score: z.number() }).strict(),
        })
        .strict(),
      outcomeKinds: ['scored'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute(invocation) {
          return {
            kind: 'scored',
            data: { score: invocation.input.value === 7 ? 7 : ('invalid' as never) },
          };
        },
      },
    });
    const service = createExecutionService(
      new InMemoryEventJournal(new FakeClock()),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock: new FakeClock(), ids: new SequentialIds() },
    );
    const scoreActivation = {
      ...activation,
      activity: activityName('score'),
      input: { value: 7 },
    };

    await expect(service.attempt(scoreActivation, context)).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { kind: 'scored', data: { score: 7 } },
    });
    await expect(
      service.attempt(
        { ...scoreActivation, activationId: activationId('score-invalid'), input: { value: 0 } },
        context,
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        details: { sourceKind: 'Error' },
      },
    });
  });

  it('publishes branded execution commands end to end', () => {
    expectTypeOf<ExecutionActivation['activationId']>().toEqualTypeOf<ActivationId>();
    expectTypeOf<ExecutionActivation['activity']>().toEqualTypeOf<ActivityName>();
    expectTypeOf<
      ExecutionAttemptContext['workflowInstanceId']
    >().toEqualTypeOf<ActivityWorkflowInstanceId>();
    expectTypeOf<
      ExecutionAttemptContext['orchestrationGroupId']
    >().toEqualTypeOf<ActivityOrchestrationGroupId>();
  });
});

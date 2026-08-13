import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activationId } from '../../../src/activities/contracts/identifiers.js';
import { ActivityRegistry, activityName } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  orchestrationActivityOutcome,
  startInstance,
  type StartInstanceInput,
} from '../../../src/orchestration/index.js';
import {} from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';

const activities = new ActivityRegistry();
for (const name of ['implement', 'review'])
  activities.register({
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'blocked', 'failed']) }).strict(),
    outcomeKinds: ['done', 'blocked', 'failed'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
const definition = compileWorkflow(
  'default',
  {
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        on: {
          done: { activities: [{ use: 'review', with: {} }], then: 'done' },
          blocked: { then: 'await-human' },
        },
        requiresApproval: false,
      },
    },
  },
  activities,
);
const start = {
  workflowInstanceId: workflowInstanceId('workflow-1'),
  workItemId: workId('1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  definition,
  occurredAt: '2026-07-30T12:00:00.000Z',
  correlationId: 'correlation-1',
  causationId: 'command-1',
};
// @ts-expect-error A child start requires its complete durable provenance.
const malformedChildStart: StartInstanceInput = {
  ...start,
  parentWorkflowInstanceId: workflowInstanceId('parent-1'),
};
void malformedChildStart;

describe('workflow interpreter', () => {
  it('starts at entry and requests one stable activation', () => {
    const decision = startInstance(start);
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    const view = foldWorkflowInstance(decision.events);
    expect(view?.currentStage).toBe('implement');
    expect(view?.pendingActivation?.activationId).toBe('workflow-1:activity:1');
  });

  it('runs follow-ons in order and completes terminal routes', () => {
    const started = startInstance(start);
    if (started.kind !== 'append') throw new Error('expected events');
    const state = foldWorkflowInstance(started.events)!;
    const first = acceptActivityOutcome(definition, state, {
      activationId: state.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({ kind: 'done' }),
      occurredAt: start.occurredAt,
      causationId: 'run-1',
    });
    if (first.kind !== 'append') throw new Error('expected events');
    const reviewing = foldWorkflowInstance([...started.events, ...first.events])!;
    expect(reviewing.pendingActivation?.activity).toBe('review');
    const second = acceptActivityOutcome(definition, reviewing, {
      activationId: reviewing.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({ kind: 'done' }),
      occurredAt: start.occurredAt,
      causationId: 'run-2',
    });
    if (second.kind !== 'append') throw new Error('expected events');
    expect(
      foldWorkflowInstance([...started.events, ...first.events, ...second.events])?.status,
    ).toBe('completed');
  });
});

describe('workflow follow-ons', () => {
  it('requests every configured follow-on before transitioning', () => {
    const multiple = compileWorkflow(
      'multiple',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: {
              done: {
                activities: [
                  { use: 'review', with: {} },
                  { use: 'implement', with: {} },
                ],
                then: 'done',
              },
            },
            requiresApproval: false,
          },
        },
      },
      activities,
    );
    const initial = startInstance({ ...start, definition: multiple });
    if (initial.kind !== 'append') throw new Error('expected events');
    let events = [...initial.events];
    for (const expectedActivity of ['review', 'implement']) {
      const state = foldWorkflowInstance(events)!;
      const decision = acceptActivityOutcome(multiple, state, {
        activationId: state.pendingActivation!.activationId,
        outcome: orchestrationActivityOutcome({ kind: 'done' }),
        occurredAt: start.occurredAt,
        causationId: `run-${state.pendingActivation!.ordinal}`,
      });
      if (decision.kind !== 'append') throw new Error('expected events');
      events = [...events, ...decision.events];
      expect(foldWorkflowInstance(events)?.pendingActivation?.activity).toBe(expectedActivity);
    }
    const state = foldWorkflowInstance(events)!;
    const terminal = acceptActivityOutcome(multiple, state, {
      activationId: state.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({ kind: 'done' }),
      occurredAt: start.occurredAt,
      causationId: 'run-terminal',
    });
    if (terminal.kind !== 'append') throw new Error('expected events');
    expect(foldWorkflowInstance([...events, ...terminal.events])?.status).toBe('completed');
  });
});

describe('workflow outcome acceptance', () => {
  it('ignores duplicate or non-pending outcomes and waits for humans', () => {
    const started = startInstance(start);
    if (started.kind !== 'append') throw new Error('expected events');
    const state = foldWorkflowInstance(started.events)!;
    expect(
      acceptActivityOutcome(definition, state, {
        activationId: activationId('other'),
        outcome: orchestrationActivityOutcome({ kind: 'done' }),
        occurredAt: start.occurredAt,
        causationId: 'x',
      }).kind,
    ).toBe('ignored');
    const waiting = acceptActivityOutcome(definition, state, {
      activationId: state.pendingActivation!.activationId,
      outcome: orchestrationActivityOutcome({ kind: 'blocked' }),
      occurredAt: start.occurredAt,
      causationId: 'run-1',
    });
    if (waiting.kind !== 'append') throw new Error('expected events');
    expect(foldWorkflowInstance([...started.events, ...waiting.events])?.status).toBe('waiting');
  });

  it('durably blocks — rather than silently dropping — an outcome its stage never routed', () => {
    const started = startInstance(start);
    if (started.kind !== 'append') throw new Error('expected events');
    const state = foldWorkflowInstance(started.events)!;
    const activation = state.pendingActivation!.activationId;

    const decision = acceptActivityOutcome(definition, state, {
      activationId: activation,
      outcome: orchestrationActivityOutcome({ kind: 'failed' }),
      occurredAt: start.occurredAt,
      causationId: 'run-unrouted',
    });
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    const resolved = foldWorkflowInstance([...started.events, ...decision.events])!;

    expect(resolved.status).toBe('blocked');
    // The outcome is recorded as accepted even though it had nowhere to
    // route, so nothing can later mistake this activation for still being
    // open and resolve it through an unrelated signal.
    expect(resolved.acceptedOutcomes).toContain(activation);

    const late = acceptActivityOutcome(definition, resolved, {
      activationId: activation,
      outcome: orchestrationActivityOutcome({ kind: 'done' }),
      occurredAt: start.occurredAt,
      causationId: 'run-unrouted-late',
    });
    expect(late.kind).toBe('ignored');
  });
});

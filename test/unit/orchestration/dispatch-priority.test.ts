import { describe, expect, it } from 'vitest';
import { ActivityEventType, activityName } from '../../../src/activities/index.js';
import {
  remainingAgentSteps,
  UnreachableRemainingSteps,
} from '../../../src/orchestration/domain/workflow-graph.js';
import {
  activityRequestedSchema,
  signalName,
  stageName,
  TransitionTargetKind,
  watchId,
  type CompiledStage,
  type TransitionTarget,
} from '../../../src/orchestration/index.js';

const complete = { kind: TransitionTargetKind.Complete } as const;
const goto = (stage: string) => ({ kind: TransitionTargetKind.Stage, stage: stageName(stage) });

function stage(activity: string, routes: Record<string, TransitionTarget>): CompiledStage {
  return {
    activity: activityName(activity),
    with: {},
    on: Object.fromEntries(
      Object.entries(routes).map(([kind, target]) => [
        kind,
        { id: kind, target, reentryTarget: target },
      ]),
    ),
  };
}

const isAgent = (activity: string) => activity !== 'wait' && activity !== 'merge';

describe('remainingAgentSteps', () => {
  it('counts agent stages on the cheapest path and treats non-agent stages as free', () => {
    const costs = remainingAgentSteps(
      {
        [stageName('implement')]: stage('implement', { done: goto('review') }),
        [stageName('review')]: stage('review', {
          approved: goto('merge'),
          changes: goto('implement'),
        }),
        [stageName('merge')]: stage('merge', { done: complete }),
        [stageName('gate')]: stage('wait', { done: goto('merge') }),
      },
      isAgent,
    );
    expect(costs).toMatchObject({ implement: 2, review: 1, merge: 0, gate: 0 });
  });

  it('never routes a loop-back along the shortest path and ranks dead ends last', () => {
    const costs = remainingAgentSteps(
      {
        [stageName('a')]: stage('implement', { done: goto('b'), retry: goto('a') }),
        [stageName('b')]: stage('review', { done: complete, again: goto('a') }),
        [stageName('loop')]: stage('implement', { done: goto('loop') }),
      },
      isAgent,
    );
    expect(costs).toMatchObject({ a: 2, b: 1, loop: UnreachableRemainingSteps });
  });
});

describe('activity requested watchDriven', () => {
  const base = {
    activationId: 'activation-00000000000000000000000001',
    ordinal: 1,
    activity: 'review',
    input: {},
  };

  it('decodes absence and true, and rejects false', () => {
    expect(activityRequestedSchema.safeParse(base).success).toBe(true);
    expect(activityRequestedSchema.safeParse({ ...base, watchDriven: true }).success).toBe(true);
    expect(activityRequestedSchema.safeParse({ ...base, watchDriven: false }).success).toBe(false);
  });
});

it('finds the minimum through signal resumes, watch rejection, and resource transitions', () => {
  const waitTarget = { kind: TransitionTargetKind.ResourceTransitionWait } as const;
  const waiting = stage('wait', {});
  const route = { id: 'waiting', reentryTarget: goto('waiting'), target: waitTarget };
  const costs = remainingAgentSteps(
    {
      [stageName('waiting')]: {
        ...waiting,
        on: {
          done: {
            ...route,
            resourceTransitions: [
              { event: ActivityEventType.PrReviewAccepted, target: goto('short') },
            ],
          },
        },
      },
      [stageName('signal')]: {
        ...waiting,
        on: {
          done: {
            ...route,
            await: { signal: signalName('ready'), from: [], resume: goto('short') },
          },
        },
      },
      [stageName('watch')]: {
        ...waiting,
        on: {
          done: {
            ...route,
            target: goto('long'),
            watchGates: [{ watch: watchId('review'), onRejectTarget: goto('short') }],
          },
        },
      },
      [stageName('long')]: stage('implement', { done: goto('short') }),
      [stageName('short')]: stage('review', { done: complete }),
      [stageName('dead')]: stage('wait', { done: waitTarget }),
    },
    isAgent,
  );
  expect(costs).toEqual({
    waiting: 1,
    signal: 1,
    watch: 1,
    long: 2,
    short: 1,
    dead: UnreachableRemainingSteps,
  });
  expect(JSON.parse(JSON.stringify(costs)).dead).toBe(UnreachableRemainingSteps);
});

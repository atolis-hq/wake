import { describe, expect, it } from 'vitest';
import { activityName } from '../../../src/activities/index.js';
import {
  remainingAgentSteps,
  UnreachableRemainingSteps,
} from '../../../src/orchestration/domain/workflow-graph.js';
import {
  activityRequestedSchema,
  stageName,
  TransitionTargetKind,
  type CompiledStage,
} from '../../../src/orchestration/index.js';

const complete = { kind: TransitionTargetKind.Complete } as const;
const goto = (stage: string) => ({ kind: TransitionTargetKind.Stage, stage: stageName(stage) });

function stage(activity: string, routes: Record<string, unknown>): CompiledStage {
  return {
    activity: activityName(activity),
    on: Object.fromEntries(
      Object.entries(routes).map(([kind, target]) => [kind, { id: kind, target }]),
    ),
  } as unknown as CompiledStage;
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

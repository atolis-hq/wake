import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ActivityExecutionKind,
  ActivityRegistry,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  activityName,
  activationId,
  type ActivityDefinition,
  type ActivityInvocation,
} from '../../src-next/activities/index.js';
import { workItemId } from '../../src-next/work/index.js';

interface ScoredOutcome {
  readonly kind: 'scored';
  readonly data: { readonly score: number };
}

const scoredActivity = {
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
      return { kind: 'scored', data: { score: invocation.input.value } };
    },
  },
} satisfies ActivityDefinition<
  ReturnType<typeof activityName>,
  { readonly value: number },
  ScoredOutcome
>;

describe('Activity outcome contracts', () => {
  it('retains an Activity-specific outcome through registration and execution', async () => {
    const registry = new ActivityRegistry();
    registry.register(scoredActivity);
    const resolved = registry.get<typeof scoredActivity>(scoredActivity.name);
    const invocation: ActivityInvocation<{ readonly value: number }> = {
      activationId: activationId('activation-1'),
      activity: scoredActivity.name,
      workItemId: workItemId('work-1'),
      workflowInstanceId: activityWorkflowInstanceId('workflow-1'),
      orchestrationGroupId: activityOrchestrationGroupId('group-1'),
      causationId: 'cause-1',
      input: { value: 7 },
      resources: [],
    };

    const outcome = await registry.execute(resolved, invocation, {
      signal: new AbortController().signal,
      occurredAt: '2026-07-31T00:00:00.000Z',
      async reportExternalExecution(_reference) {},
    });

    expect(outcome).toEqual({ kind: 'scored', data: { score: 7 } });
    expectTypeOf(outcome).toMatchTypeOf<ScoredOutcome>();
    expectTypeOf(outcome.kind).toEqualTypeOf<'scored'>();
    expectTypeOf(registry.validateInput(resolved, { value: 1 })).toEqualTypeOf<{
      value: number;
    }>();
    expectTypeOf(
      registry.validateOutcome(resolved, { kind: 'scored', data: { score: 1 } }),
    ).toMatchTypeOf<ScoredOutcome>();
  });

  it('rejects duplicate outcome kinds and outcomes outside the declaration', () => {
    const registry = new ActivityRegistry();
    expect(() =>
      registry.register({ ...scoredActivity, outcomeKinds: ['scored', 'scored'] }),
    ).toThrow(/duplicate Activity outcome kind/i);
    registry.register(scoredActivity);
    expect(() => registry.validateOutcome(scoredActivity.name, { kind: 'undeclared' })).toThrow(
      /undeclared Activity outcome kind/i,
    );
  });

  it('does not let activities/review parse GitHub comment syntax', async () => {
    const contracts = await readFile(
      new URL('../../src-next/activities/review/contracts.ts', import.meta.url),
      'utf8',
    );
    const signals = await readFile(
      new URL('../../src-next/activities/review/signals.ts', import.meta.url),
      'utf8',
    );
    expect(`${contracts}\n${signals}`).not.toMatch(/\/accepted|\/changes|\.split\(/);
  });
});

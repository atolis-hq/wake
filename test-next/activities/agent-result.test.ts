import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  activityName,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
  activationId,
  agentActivityOutcomeKinds,
  agentActivityOutcomeSchema,
  createAgentActivity,
  translateAgentResult,
  type AgentActivityOutcome,
} from '../../src-next/activities/index.js';
import { workItemId } from '../../src-next/work/index.js';
describe('agent results', () => {
  it.each([
    ['DONE', 'done'],
    ['REJECTED', 'rejected'],
    ['BLOCKED', 'blocked'],
    ['FAILED', 'failed'],
  ] as const)('maps %s', (status, kind) =>
    expect(translateAgentResult({ status })).toEqual({ kind, data: { status } }),
  );
  it('never treats missing structured agent output as done', () =>
    expect(translateAgentResult(undefined)).toEqual({
      kind: 'failed',
      data: { reason: 'invalid-agent-result' },
    }));

  it('owns an exact closed outcome contract', () => {
    expect(agentActivityOutcomeKinds).toEqual([
      ActivityOutcomeKind.Done,
      ActivityOutcomeKind.Rejected,
      ActivityOutcomeKind.Blocked,
      ActivityOutcomeKind.Failed,
    ]);
    expect(
      agentActivityOutcomeSchema.parse({
        kind: ActivityOutcomeKind.Blocked,
        data: { reason: ActivityFailureCode.AmbiguousRunnerResult },
      }),
    ).toEqual({
      kind: ActivityOutcomeKind.Blocked,
      data: { reason: ActivityFailureCode.AmbiguousRunnerResult },
    });
    expect(() =>
      agentActivityOutcomeSchema.parse({
        kind: ActivityOutcomeKind.Waiting,
        data: { intentEventId: 'intent-1', signalKind: 'accepted' },
      }),
    ).toThrow();
    expect(() =>
      agentActivityOutcomeSchema.parse({
        kind: ActivityOutcomeKind.Blocked,
        data: { reason: ActivityFailureCode.RunnerFailed },
      }),
    ).toThrow();
    expect(() =>
      agentActivityOutcomeSchema.parse({
        kind: ActivityOutcomeKind.Failed,
        data: { reason: ActivityFailureCode.AmbiguousRunnerResult },
      }),
    ).toThrow();
    expectTypeOf(translateAgentResult({ status: 'DONE' })).toEqualTypeOf<AgentActivityOutcome>();
  });

  it('maps raw provider failures to the canonical Agent failure contract', async () => {
    const handler = createAgentActivity({
      async start() {
        return {
          result: Promise.resolve({
            transport: 'failed' as const,
            output: '',
            failure: { kind: 'provider-quota-exceeded', message: 'quota exhausted' },
          }),
        };
      },
    });

    await expect(
      handler.execute(
        {
          activationId: activationId('activation-1'),
          activity: activityName('agent'),
          workItemId: workItemId('work-1'),
          workflowInstanceId: activityWorkflowInstanceId('workflow-1'),
          orchestrationGroupId: activityOrchestrationGroupId('group-1'),
          causationId: 'cause-1',
          input: { prompt: 'ship' },
          resources: [],
        },
        {
          signal: new AbortController().signal,
          occurredAt: '2026-07-31T00:00:00.000Z',
          async reportExternalExecution() {},
        },
      ),
    ).resolves.toEqual({
      kind: ActivityOutcomeKind.Failed,
      data: { reason: ActivityFailureCode.RunnerFailed, message: 'quota exhausted' },
    });
  });
});

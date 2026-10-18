import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  activityOrchestrationGroupId,
  ActivityRegistry,
  activityWorkflowInstanceId,
  agentActivityDefinition,
  BuiltInActivityName,
  createAgentActivity,
} from '../../../src/activities/index.js';
import { createClaudeRunner, RunStatus } from '../../../src/execution/index.js';
import { parseAgentRunnerResponse } from '../../../src/execution/infrastructure/agent-runner-adapter.js';
import { formatAgentRunComment } from '../../../src/integrations/github/application/agent-run-comment.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  orchestrationActivityOutcome,
  orchestrationGroupId,
  startInstance,
  workflowInstanceId,
  workflowInstanceStream,
  type WorkflowOrchestrationEventData,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it('routes a real Claude auth failure to human intervention with its message and no retries', async () => {
  const activities = new ActivityRegistry();
  activities.register(agentActivityDefinition);
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'agent',
          with: { prompt: 'auth-error' },
          on: {
            done: { then: 'done' },
            blocked: { then: 'await-human' },
            failed: { retry: { max: 3 }, then: 'await-human' },
          },
        },
      },
    },
    activities,
  );
  const occurredAt = '2026-10-18T12:00:00.000Z';
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-auth'),
    workItemId: workId('1'),
    orchestrationGroupId: orchestrationGroupId('group-auth'),
    definition,
    occurredAt,
    correlationId: 'auth',
    causationId: 'auth',
  });
  if (started.kind !== 'append') throw new Error('expected start');
  const fold = (events: readonly WorkflowOrchestrationEventData[]) =>
    foldWorkflowInstance(
      events.map((event, index) => ({
        event,
        stream: workflowInstanceStream(workflowInstanceId('workflow-auth')),
        recordedAt: event.occurredAt,
        sequence: index + 1,
        globalPosition: index + 1,
      })),
    )!;
  const state = fold(started.events);
  const runner = createClaudeRunner({
    command: fileURLToPath(new URL('./fixtures/claude-progress.cjs', import.meta.url)),
  });
  const result = await (
    await runner.start(
      { runId: 'auth-run', prompt: 'auth-error', allowedTools: [] },
      new AbortController().signal,
    )
  ).result;
  const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  expect(result).toMatchObject({ transport: RunStatus.Failed, failure: { message } });
  const response = parseAgentRunnerResponse(result);
  expect(response).toMatchObject({ outcome: 'BLOCKED', displayBody: message });
  expect(formatAgentRunComment({ ...response, idempotencyKey: 'auth-run' })).toContain(message);
  const outcome = await createAgentActivity().execute(
    {
      activationId: state.pendingActivation!.activationId,
      activity: BuiltInActivityName.Agent,
      workItemId: workId('1'),
      workflowInstanceId: activityWorkflowInstanceId('workflow-auth'),
      orchestrationGroupId: activityOrchestrationGroupId('group-auth'),
      causationId: 'auth',
      input: { prompt: 'auth-error' },
      resources: [],
    },
    {
      signal: new AbortController().signal,
      occurredAt,
      runId: 'auth-run',
      runner: {
        async start() {
          return { result: Promise.resolve(result) };
        },
      },
      async reportExternalExecution() {},
    },
  );
  expect(outcome).toMatchObject({
    kind: 'blocked',
    data: { reason: 'runner-authentication-required', message },
  });
  const decision = acceptActivityOutcome(definition, state, {
    activationId: state.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome(outcome),
    occurredAt,
    causationId: 'auth-result',
  });
  if (decision.kind !== 'append') throw new Error('expected blocked route');
  const waiting = fold([...started.events, ...decision.events]);
  expect(waiting.status).toBe('waiting');
  expect(waiting.retryCounts).toEqual({});
  expect(decision.events.map((event) => event.eventType)).not.toContain(
    'orchestration.activity-retried-for-runner-quota',
  );
});

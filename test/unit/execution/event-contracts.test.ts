import { describe, expect, it } from 'vitest';
import { activationId } from '../../../src/activities/contracts/identifiers.js';
import { activityName } from '../../../src/activities/index.js';
import {
  activationStream,
  createExecutionEventData,
  decodeActivationExecutionEvent,
  decodeExecutionEvent,
  decodeRunExecutionEvent,
  ExecutionEventType,
  ExecutionFailureCode,
  runId,
  runStream,
  selectExecutionEvent,
  selectRunExecutionEvent,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';

const stream = runStream(runId('run-1'));
const runSamples = [
  [
    ExecutionEventType.RunPreparationStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T11:59:00.000Z',
      runner: { name: 'codex', model: 'gpt-5.1', effort: 'high', pool: 'default', cli: 'codex' },
    },
  ],
  [
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
      workspace: { mode: 'branch', path: 'C:\\repo', branch: 'wake/work-1' },
    },
  ],
  [
    ExecutionEventType.RunSucceeded,
    {
      outcome: { kind: 'done', data: { result: 'ok' } },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [
    ExecutionEventType.RunFailed,
    {
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        message: 'failed',
        details: { sourceKind: 'TypeError' },
      },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [
    ExecutionEventType.RunLeaseClaimed,
    {
      owner: 'resident-a',
      acquiredAt: '2026-07-31T12:00:00.000Z',
      expiresAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [
    ExecutionEventType.RunLeaseRenewed,
    {
      owner: 'resident-a',
      acquiredAt: '2026-07-31T12:00:00.000Z',
      expiresAt: '2026-07-31T12:02:00.000Z',
    },
  ],
  [
    ExecutionEventType.RunExternalExecutionReported,
    { kind: 'process', id: 'process-1', startedAt: '2026-07-31T12:00:00.000Z' },
  ],
  [
    ExecutionEventType.RunRunnerResultReported,
    {
      transport: 'succeeded',
      agent: {
        outcome: 'DONE',
        displayBody: 'Completed the requested work.',
        metadata: {
          runner: 'fake',
          sessionId: 'session-1',
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.03,
        },
      },
    },
  ],
  [ExecutionEventType.RunWorkspaceCleanupFailed, { message: 'EACCES: workspace still in use' }],
  [
    ExecutionEventType.RunCancellationRequested,
    { requestedAt: '2026-07-31T12:00:00.000Z', reason: 'timeout' },
  ],
  [ExecutionEventType.RunCancellationConfirmed, { confirmedAt: '2026-07-31T12:01:00.000Z' }],
  [ExecutionEventType.RunCancelled, { finishedAt: '2026-07-31T12:01:00.000Z' }],
  [
    ExecutionEventType.RunRecovered,
    {
      result: {
        transport: 'succeeded',
        agent: { outcome: 'DONE', displayBody: 'Recovered.', metadata: { runner: 'fake' } },
      },
      outcome: { kind: 'done' },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [ExecutionEventType.RunAmbiguityObserved, { reason: 'runner unavailable', attempt: 1 }],
  [
    ExecutionEventType.RunAmbiguous,
    { reason: 'runner unavailable', finishedAt: '2026-07-31T12:01:00.000Z' },
  ],
] as const;

const activation = activationId('activation-1');
const activationSamples = [
  [
    ExecutionEventType.ActivationClaimed,
    {
      runId: runId('run-1'),
      owner: 'resident-a',
      expiresAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [ExecutionEventType.ActivationReleased, { runId: runId('run-1') }],
] as const;

describe('Execution event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect([
      ...runSamples.map(([type, payload]) =>
        decodeRunExecutionEvent(eventEnvelope(type, payload, stream)),
      ),
      ...activationSamples.map(([type, payload]) =>
        decodeActivationExecutionEvent(eventEnvelope(type, payload, activationStream(activation))),
      ),
    ]).toHaveLength(Object.keys(ExecutionEventType).length);
  });

  it('rejects unknown, malformed, and wrong-stream owned events', () => {
    expect(() => decodeExecutionEvent(eventEnvelope('execution.unknown', {}, stream))).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunPreparationStarted,
          { activationId: activationId('x') },
          stream,
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(ExecutionEventType.RunFailed, runSamples[2][1], {
          kind: 'resource',
          id: 'resource-1',
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(ExecutionEventType.ActivationClaimed, activationSamples[0][1], stream),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunStarted,
          runSamples[1][1],
          activationStream(activation),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.ActivationClaimed,
          { runId: runId('run-1'), owner: 'resident-a' },
          activationStream(activation),
        ),
      ),
    ).toThrow();
  });

  it.each([
    eventEnvelope(ExecutionEventType.RunSucceeded, runSamples[2][1], {
      kind: 'execution-run',
      id: ' ',
    }),
    eventEnvelope(
      ExecutionEventType.RunPreparationStarted,
      { ...runSamples[0][1], activationId: '' },
      stream,
    ),
  ])('reports invalid IDs through the Execution decoder context', (event) => {
    expect(() => decodeExecutionEvent(event)).toThrow(
      /Invalid Execution event event-7 at global position 7/i,
    );
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectExecutionEvent(eventEnvelope('work.item-created', {}, stream))).toBeNull();
    expect(() => selectExecutionEvent(eventEnvelope('execution.unknown', {}, stream))).toThrow(
      /event-7.*position 7.*execution\.unknown/i,
    );
  });

  it('selects a valid activation event through the Execution contract', () => {
    const selected = selectExecutionEvent(
      eventEnvelope(
        ExecutionEventType.ActivationClaimed,
        activationSamples[0][1],
        activationStream(activation),
      ),
    );

    expect(selected?.event.eventType).toBe(ExecutionEventType.ActivationClaimed);
  });

  it('selects and creates preparation events on run streams', () => {
    const preparation = eventEnvelope(
      ExecutionEventType.RunPreparationStarted,
      runSamples[0][1],
      stream,
    );

    expect(selectRunExecutionEvent(preparation)?.event.eventType).toBe(
      ExecutionEventType.RunPreparationStarted,
    );
    expect(createExecutionEventData(preparation.event)).toMatchObject({
      eventType: ExecutionEventType.RunPreparationStarted,
      payload: runSamples[0][1],
    });
  });

  it('rejects provider or Error names as machine failure kinds', () => {
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunFailed,
          {
            failure: { kind: 'TypeError', message: 'failed' },
            finishedAt: '2026-07-31T12:01:00.000Z',
          },
          stream,
        ),
      ),
    ).toThrow();
  });

  it('rejects an empty originating stage', () => {
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunPreparationStarted,
          { ...runSamples[0][1], stage: '' },
          stream,
        ),
      ),
    ).toThrow(/stage/i);
  });

  it('rejects preparation events carrying a workspace or activation stream', () => {
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunPreparationStarted,
          { ...runSamples[0][1], workspace: { mode: 'branch', path: 'C:\\repo' } },
          stream,
        ),
      ),
    ).toThrow(/workspace/i);
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(
          ExecutionEventType.RunPreparationStarted,
          runSamples[0][1],
          activationStream(activation),
        ),
      ),
    ).toThrow();
  });
});

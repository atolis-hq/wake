import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { describe, expect, it } from 'vitest';
import {
  decodeExecutionEvent,
  ExecutionFailureCode,
  ExecutionEventType,
  runId,
  runStream,
  selectExecutionEvent,
} from '../../src-next/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../src-next/orchestration/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const stream = runStream(runId('run-1'));
const samples = [
  [
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
      workspace: { mode: 'branch', path: 'C:\\repo' },
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
    ExecutionEventType.RunCancellationRequested,
    { requestedAt: '2026-07-31T12:00:00.000Z', reason: 'timeout' },
  ],
  [ExecutionEventType.RunCancellationConfirmed, { confirmedAt: '2026-07-31T12:01:00.000Z' }],
  [ExecutionEventType.RunCancelled, { finishedAt: '2026-07-31T12:01:00.000Z' }],
  [
    ExecutionEventType.RunRecovered,
    {
      result: { transport: 'succeeded', output: 'DONE', runner: 'fake' },
      outcome: { kind: 'done' },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
  ],
  [
    ExecutionEventType.RunAmbiguous,
    { reason: 'runner unavailable', finishedAt: '2026-07-31T12:01:00.000Z' },
  ],
] as const;

describe('Execution event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect(
      samples.map(([type, payload]) => decodeExecutionEvent(eventEnvelope(type, payload, stream))),
    ).toHaveLength(Object.keys(ExecutionEventType).length);
  });

  it('rejects unknown, malformed, and wrong-stream owned events', () => {
    expect(() => decodeExecutionEvent(eventEnvelope('execution.unknown', {}, stream))).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(ExecutionEventType.RunStarted, { activationId: activationId('x') }, stream),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionEvent(
        eventEnvelope(ExecutionEventType.RunFailed, samples[2][1], {
          kind: 'resource',
          id: 'resource-1',
        }),
      ),
    ).toThrow();
  });

  it.each([
    eventEnvelope(ExecutionEventType.RunSucceeded, samples[1][1], {
      kind: 'execution-run',
      id: ' ',
    }),
    eventEnvelope(ExecutionEventType.RunStarted, { ...samples[0][1], activationId: '' }, stream),
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
});

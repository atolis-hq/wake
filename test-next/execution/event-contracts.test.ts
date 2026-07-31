import { describe, expect, it } from 'vitest';
import {
  decodeExecutionEvent,
  ExecutionEventType,
  runId,
  runStream,
  selectExecutionEvent,
} from '../../src-next/execution/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const stream = runStream(runId('run-1'));
const samples = [
  [
    ExecutionEventType.RunStarted,
    {
      activationId: 'activation-1',
      activity: 'implement',
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
      failure: { kind: 'Error', message: 'failed' },
      finishedAt: '2026-07-31T12:01:00.000Z',
    },
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
        eventEnvelope(ExecutionEventType.RunStarted, { activationId: 'x' }, stream),
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

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectExecutionEvent(eventEnvelope('work.item-created', {}, stream))).toBeNull();
    expect(() => selectExecutionEvent(eventEnvelope('execution.unknown', {}, stream))).toThrow(
      /event-7.*position 7.*execution\.unknown/i,
    );
  });
});

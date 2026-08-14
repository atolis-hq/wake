import { describe, expect, it } from 'vitest';
import {
  decodeResourceEvent,
  resourceCapability,
  ResourceEventType,
  resourceStream,
  selectResourceEvent,
} from '../../../src/resources/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId, workId } from '../../support/identities.js';

const stream = resourceStream(resId('one'));
const samples = [
  [
    ResourceEventType.ResourceDiscovered,
    {
      kind: 'pull-request',
      externalKey: { adapter: 'github', key: 'wake#1' },
      capabilities: [resourceCapability('commentable'), resourceCapability('reviewable')],
      revision: 'abc',
      title: 'Improve intake',
    },
  ],
  [ResourceEventType.ResourceRevisionObserved, { revision: 'def' }],
  [ResourceEventType.IssueCompletionObservationConsumed, { intentEventId: 'complete-intent' }],
  [
    ResourceEventType.WorkCorrelationEstablished,
    { workItemId: workId('one'), role: 'primary', provenance: 'provider-observed' },
  ],
  [ResourceEventType.WorkCorrelationRetracted, { workItemId: workId('one') }],
  [
    ResourceEventType.WorkCorrelationConflicted,
    {
      workItemId: workId('two'),
      existingWorkItemId: workId('one'),
    },
  ],
] as const;

describe('Resource event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect(
      samples.map(([type, payload]) => decodeResourceEvent(eventEnvelope(type, payload, stream))),
    ).toHaveLength(Object.keys(ResourceEventType).length);
  });

  it('rejects unknown, malformed, and wrong-stream owned events', () => {
    expect(() => decodeResourceEvent(eventEnvelope('resources.unknown', {}, stream))).toThrow();
    expect(() =>
      decodeResourceEvent(
        eventEnvelope(ResourceEventType.ResourceRevisionObserved, { revision: 3 }, stream),
      ),
    ).toThrow();
    expect(() =>
      decodeResourceEvent(
        eventEnvelope(
          ResourceEventType.ResourceRevisionObserved,
          { revision: 'x' },
          {
            kind: 'work-item',
            id: 'work-1',
          },
        ),
      ),
    ).toThrow();
  });

  it.each([
    eventEnvelope(
      ResourceEventType.ResourceRevisionObserved,
      { revision: 'x' },
      { kind: 'resource', id: 'invalid-resource-id' },
    ),
    eventEnvelope(
      ResourceEventType.WorkCorrelationEstablished,
      { workItemId: 'invalid-work-id', role: 'primary' },
      stream,
    ),
  ])('reports invalid branded IDs through the Resource decoder context', (event) => {
    expect(() => decodeResourceEvent(event)).toThrow(
      /Invalid Resource event event-7 at global position 7/i,
    );
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectResourceEvent(eventEnvelope('work.item-created', {}, stream))).toBeNull();
    expect(() => selectResourceEvent(eventEnvelope('resources.unknown', {}, stream))).toThrow(
      /event-7.*position 7.*resources\.unknown/i,
    );
  });

  it('still decodes a ResourceDiscovered event recorded before title existed', () => {
    expect(() =>
      decodeResourceEvent(
        eventEnvelope(
          ResourceEventType.ResourceDiscovered,
          {
            kind: 'issue',
            externalKey: { adapter: 'github', key: 'wake#2' },
            capabilities: [resourceCapability('commentable')],
          },
          stream,
        ),
      ),
    ).not.toThrow();
  });
});

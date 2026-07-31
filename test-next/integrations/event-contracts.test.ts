import { describe, expect, it } from 'vitest';
import {
  BuiltInAdapterId,
  decodeGitHubAdapterEvent,
  GitHubEventType,
  integrationStream,
  selectGitHubAdapterEvent,
} from '../../src-next/integrations/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const stream = integrationStream(BuiltInAdapterId.GitHub);
const actor = { id: 'octocat', kind: 'human' } as const;
const samples = [
  [
    GitHubEventType.WorkObserved,
    {
      externalKey: 'atolis/wake#1',
      kind: 'pull-request',
      title: 'Typed events',
      body: 'Ship them',
      state: 'open',
      revision: 'abc',
      headRevision: 'abc',
      baseRevision: 'def',
      checks: 'passing',
      actor,
      raw: { number: 1 },
    },
  ],
  [
    GitHubEventType.CommentObserved,
    {
      externalKey: 'atolis/wake#1',
      body: '/accepted',
      revision: 'abc',
      actor,
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'octocat' },
      raw: { reviewId: 1 },
    },
  ],
  [GitHubEventType.DeliveryObserved, { deliveryId: 'delivery-1', raw: { status: 'ok' } }],
] as const;

describe('GitHub adapter event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect(
      samples.map(([type, payload]) =>
        decodeGitHubAdapterEvent(eventEnvelope(type, payload, stream)),
      ),
    ).toHaveLength(Object.keys(GitHubEventType).length);
  });

  it('rejects unknown, malformed, and wrong-stream owned events', () => {
    expect(() =>
      decodeGitHubAdapterEvent(eventEnvelope('integration.github.unknown', {}, stream)),
    ).toThrow();
    expect(() =>
      decodeGitHubAdapterEvent(
        eventEnvelope(GitHubEventType.WorkObserved, { externalKey: 'wake#1' }, stream),
      ),
    ).toThrow();
    expect(() =>
      decodeGitHubAdapterEvent(
        eventEnvelope(GitHubEventType.DeliveryObserved, samples[2][1], {
          kind: 'resource',
          id: 'resource-1',
        }),
      ),
    ).toThrow();
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectGitHubAdapterEvent(eventEnvelope('work.item-created', {}, stream))).toBeNull();
    expect(() =>
      selectGitHubAdapterEvent(eventEnvelope('integration.github.unknown', {}, stream)),
    ).toThrow(/event-7.*position 7.*integration\.github\.unknown/i);
  });
});

import { describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../src/core/policy-engine.js';
import { parseWakeConfig } from '../../src/domain/schema.js';
import { createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return parseWakeConfig({
    paths: { wakeRoot: '/tmp/wake' },
    sources: {
      github: {
        enabled: true,
        repos: ['org/repo'],
        policy: { requiredLabels: ['wake:assign'], requiredAssignees: [] },
        pullRequests: { enabled: true, policy: { requiredAuthors: ['trusted-human'] } },
        ...overrides,
      },
    },
  });
}

describe('qualifiesForMint', () => {
  const policy = createPolicyEngine();

  it('qualifies a github:issue event carrying a matching label', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e1',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#1' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { labels: ['wake:assign'], assignees: [] } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(true);
  });

  it('does not qualify a github:issue event missing the required label', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e2',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#2' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { labels: [], assignees: [] } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });

  it('qualifies a github:pr event authored by a required author', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e3',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 91, author: 'trusted-human', headRef: 'feature-x' } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(true);
  });

  it('does not qualify a github:pr event authored by an unlisted author', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e4',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#92' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 92, author: 'random-person', headRef: 'feature-y' } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });

  it('does not qualify a github:pr event, even from a required author, when pullRequests.enabled is false', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e3b',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 91, author: 'trusted-human', headRef: 'feature-x' } },
    });
    const config = baseConfig({
      pullRequests: { enabled: false, policy: { requiredAuthors: ['trusted-human'] } },
    });
    expect(policy.qualifiesForMint(event, config)).toBe(false);
  });

  it('does not qualify an event with no resourceUri', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e5',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {},
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: {},
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });

  it('qualifies matching events through workflowSelectors when configured', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e6',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#6' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { repo: 'org/repo', labels: ['bug'], assignees: [] } },
    });
    const config = baseConfig({
      policy: { requiredLabels: ['wake:assign'], requiredAssignees: [] },
    });
    config.workflowSelectors = [
      {
        workflow: 'default',
        match: {
          kind: 'issue',
          requiredLabels: ['bug'],
          ignoredLabels: [],
          requiredAssignees: [],
          requiredAuthors: [],
        },
      },
    ];

    expect(policy.qualifiesForMint(event, config)).toBe(true);
  });

  it('qualifies PR events through event-kind workflowSelectors without GitHub PR author policy', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e7',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#97' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 97, author: 'trusted-human', headRef: 'feature-x' } },
    });
    const config = baseConfig({
      pullRequests: { enabled: true, policy: { requiredAuthors: [] } },
    });
    config.workflowSelectors = [
      {
        workflow: 'default',
        match: {
          kind: 'pr',
          requiredLabels: [],
          ignoredLabels: [],
          requiredAssignees: [],
          requiredAuthors: ['trusted-human'],
        },
      },
    ];

    expect(policy.qualifiesForMint(event, config)).toBe(true);
  });

  it('does not qualify selector-configured events when no selector matches', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e8',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#8' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { repo: 'org/repo', labels: ['feature'], assignees: [] } },
    });
    const config = baseConfig();
    config.workflowSelectors = [
      {
        workflow: 'default',
        match: {
          kind: 'issue',
          requiredLabels: ['bug'],
          ignoredLabels: [],
          requiredAssignees: [],
          requiredAuthors: [],
        },
      },
    ];

    expect(policy.qualifiesForMint(event, config)).toBe(false);
  });
});

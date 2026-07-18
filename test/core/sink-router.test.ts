import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from '../../src/core/sink-router.js';
import type { EventEnvelope } from '../../src/domain/types.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

function publishIntent(input: {
  eventId: string;
  kind: string;
  origin: string;
  stage?: string;
}): EventEnvelope {
  return createEventEnvelope({
    eventId: input.eventId,
    // Opaque by design: routing reads `origin` below, never the key. The key
    // used to encode `<source>:<repo>#<number>`, which is the grammar minted
    // identity replaced.
    workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A70',
    streamScope: 'work-item',
    direction: 'outbound',
    sourceSystem: 'wake',
    sourceEventType: 'wake.publish.intent.requested',
    sourceRefs: {
      repo: 'atolis-hq/wake',
      issueNumber: 70,
    },
    occurredAt: '2026-07-11T12:00:00.000Z',
    ingestedAt: '2026-07-11T12:00:00.000Z',
    trigger: 'context-only',
    payload: {
      kind: input.kind,
      origin: input.origin,
      body: 'Body',
    },
    ...(input.stage === undefined ? {} : { derivedHints: { stage: input.stage } }),
  });
}

describe('sink router', () => {
  it('fans in events from all work sources in order', async () => {
    const events = await createWorkSourceFanIn([
      { source: 'one', async pollEvents() { return [publishIntent({ eventId: 'one', kind: 'status-update', origin: 'github' })]; } },
      { source: 'two', async pollEvents() { return [publishIntent({ eventId: 'two', kind: 'question', origin: 'slack' })]; } },
    ]).pollEvents();

    expect(events.map((event) => event.eventId)).toEqual(['one', 'two']);
  });

  it('routes replies to origin and additionally to subscribed sinks', async () => {
    const config = createDefaultWakeConfig('/tmp/wake-router-test');
    config.sinks = {
      slack: { kind: 'slack', channel: '#eng-wake', subscribe: ['question'] },
    };
    const delivered: { github: string[]; slack: string[] } = { github: [], slack: [] };
    const router = createOutboundSinkRouter({
      config,
      sinks: [
        {
          sink: 'github',
          async deliverIntent({ event }) {
            delivered.github.push(event.eventId);
            return [];
          },
        },
        {
          sink: 'slack',
          async deliverIntent({ event }) {
            delivered.slack.push(event.eventId);
            return [];
          },
        },
      ],
    });

    await router.deliverIntent({
      event: publishIntent({ eventId: 'question-1', kind: 'question', origin: 'github' }),
    });

    expect(delivered).toEqual({
      github: ['question-1'],
      slack: ['question-1'],
    });
  });

  it('routes a publish intent targeting a PR resource to the github-pr sink', async () => {
    const config = createDefaultWakeConfig('/tmp/wake-router-test');
    const delivered: { github: string[]; 'github-pr': string[] } = { github: [], 'github-pr': [] };
    const router = createOutboundSinkRouter({
      config,
      sinks: [
        {
          sink: 'github',
          async deliverIntent({ event }) {
            delivered.github.push(event.eventId);
            return [];
          },
        },
        {
          sink: 'github-pr',
          async deliverIntent({ event }) {
            delivered['github-pr'].push(event.eventId);
            return [];
          },
        },
      ],
    });

    await router.deliverIntent({
      event: createEventEnvelope({
        eventId: 'pr-reply-1',
        workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A70',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
        occurredAt: '2026-07-18T00:00:00.000Z',
        ingestedAt: '2026-07-18T00:00:00.000Z',
        trigger: 'context-only',
        payload: { kind: 'status-update', origin: 'github', body: 'hi' },
      }),
    });

    expect(delivered).toEqual({
      github: [],
      'github-pr': ['pr-reply-1'],
    });
  });

  it('falls back to the origin sink when the PR-resource sink is not registered, instead of dropping the reply', async () => {
    const config = createDefaultWakeConfig('/tmp/wake-router-test');
    const delivered: { github: string[] } = { github: [] };
    const router = createOutboundSinkRouter({
      config,
      sinks: [
        {
          sink: 'github',
          async deliverIntent({ event }) {
            delivered.github.push(event.eventId);
            return [];
          },
        },
        // No 'github-pr' sink registered — e.g. pullRequests.enabled was
        // flipped off after this work item's latestComment.resourceUri was
        // already stamped to a PR surface.
      ],
    });

    await router.deliverIntent({
      event: createEventEnvelope({
        eventId: 'pr-reply-orphaned',
        workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A70',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
        occurredAt: '2026-07-18T00:00:00.000Z',
        ingestedAt: '2026-07-18T00:00:00.000Z',
        trigger: 'context-only',
        payload: { kind: 'status-update', origin: 'github', body: 'hi' },
      }),
    });

    expect(delivered.github).toEqual(['pr-reply-orphaned']);
  });

  it('routes terminal-stage subscriptions only for terminal publish intents', async () => {
    const config = createDefaultWakeConfig('/tmp/wake-router-test');
    config.sinks = {
      slack: { kind: 'slack', subscribe: ['stage.terminal'] },
    };
    const delivered: string[] = [];
    const router = createOutboundSinkRouter({
      config,
      sinks: [
        {
          sink: 'github',
          async deliverIntent() {
            return [];
          },
        },
        {
          sink: 'slack',
          async deliverIntent({ event }) {
            delivered.push(event.eventId);
            return [];
          },
        },
      ],
    });

    await router.deliverIntent({
      event: publishIntent({ eventId: 'implement-status', kind: 'status-update', origin: 'github', stage: 'implement' }),
    });
    await router.deliverIntent({
      event: publishIntent({ eventId: 'done-status', kind: 'status-update', origin: 'github', stage: 'done' }),
    });

    expect(delivered).toEqual(['done-status']);
  });
});

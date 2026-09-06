import {
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  defineEventProcessor,
} from '@atolis-hq/eventing';
import { describe, expect, it } from 'vitest';
import { DurableFakeDeliveryProvider } from '../../../src/integrations/fake/durable-delivery-provider.js';
import {
  ProviderRegistry,
  adapterId,
  type ProviderDefinition,
} from '../../../src/integrations/index.js';

function definition(
  capabilityCalls?: (readonly string[])[],
): ProviderDefinition<{ readonly enabled: boolean }> {
  return {
    provider: 'fake',
    eventTypes: ['integration.fake.observed'],
    parseConfig(value) {
      if (typeof value !== 'object' || value === null || !('enabled' in value))
        throw new Error('enabled is required');
      return { enabled: value.enabled === true };
    },
    create({ adapter, config, conversationCapabilities }) {
      if (!config.enabled) throw new Error('disabled providers are not composed');
      capabilityCalls?.push(conversationCapabilities ?? []);
      return {
        adapter,
        eventTypes: ['integration.fake.observed'],
        source: {
          async poll() {
            return [];
          },
        },
        delivery: new DurableFakeDeliveryProvider(),
        inbound: {
          processor: defineEventProcessor({
            consumer: `reactor:integration.${adapter}.inbound`,
            name: 'fake-inbound',
            owner: 'integrations',
            category: EventProcessorCategory.Translator,
            replayPolicy: EventProcessorReplayPolicy.Idempotent,
            select: () => null,
            async handle() {},
          }),
        },
        reconciler: { async reconcileOnce() {} },
        async verifyArtifact() {
          return 'not-found' as const;
        },
      };
    },
  };
}

describe('ProviderRegistry', () => {
  it('defaults provider type to the adapter key and composes distinct instances', () => {
    const registry = new ProviderRegistry();
    registry.register(definition());

    const { instances, failures } = registry.compose({
      fake: { enabled: true },
      second: { provider: 'fake', enabled: true },
    });

    expect(instances.map((instance) => instance.adapter)).toEqual([
      adapterId('fake'),
      adapterId('second'),
    ]);
    expect(instances.map((instance) => instance.provider)).toEqual(['fake', 'fake']);
    expect(instances.map((instance) => instance.inbound.processor.consumer)).toEqual([
      'reactor:integration.fake.inbound',
      'reactor:integration.second.inbound',
    ]);
    expect(failures).toEqual([]);
  });

  it('rejects an adapter that does not name a registered provider', () => {
    expect(() => new ProviderRegistry().compose({ missing: { enabled: true } })).toThrow(
      'not registered',
    );
  });

  it('uses provider defaults and lets each adapter replace them', () => {
    const capabilities: (readonly string[])[] = [];
    const registry = new ProviderRegistry();
    registry.register({
      ...definition(capabilities),
      defaultConversationCapabilities: ['review-surface'],
    });

    registry.compose({
      trusted: { provider: 'fake', enabled: true },
      chat: {
        provider: 'fake',
        enabled: true,
        conversation: { capabilities: ['chat-surface'] },
      },
    });

    expect(capabilities).toEqual([['review-surface'], ['chat-surface']]);
  });

  it('reports a provider that fails to construct as a failure instead of throwing', () => {
    const registry = new ProviderRegistry();
    registry.register(definition());
    registry.register(brokenDefinition());

    const { instances, failures } = registry.compose({
      fake: { enabled: true },
      broken: { provider: 'broken', enabled: true },
    });

    expect(instances.map((instance) => instance.adapter)).toEqual([adapterId('fake')]);
    expect(failures).toEqual([
      { adapter: adapterId('broken'), provider: 'broken', error: 'provider unavailable' },
    ]);
  });
});

function brokenDefinition(): ProviderDefinition<{ readonly enabled: boolean }> {
  return {
    provider: 'broken',
    eventTypes: [],
    parseConfig(value) {
      if (typeof value !== 'object' || value === null || !('enabled' in value))
        throw new Error('enabled is required');
      return { enabled: value.enabled === true };
    },
    create() {
      throw new Error('provider unavailable');
    },
  };
}

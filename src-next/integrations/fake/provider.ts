import { z } from 'zod';
import { PullRequestCheckState } from '../../activities/index.js';
import type { ProviderDefinition } from '../contracts/provider.js';
import { DurableFakeDeliveryProvider } from './durable-delivery-provider.js';
import { FakeEventType, FakeExternalEventSource } from './external-source.js';
import { FakeInboundTranslator } from './inbound-translator.js';

const configSchema = z
  .object({
    enabled: z.boolean(),
    events: z
      .array(
        z
          .object({
            key: z.string().min(1),
            title: z.string().min(1),
            kind: z.enum(['issue', 'pull-request']).optional(),
            revision: z.string().min(1).optional(),
            baseRevision: z.string().min(1).optional(),
            checks: z
              .enum([
                PullRequestCheckState.Unknown,
                PullRequestCheckState.Pending,
                PullRequestCheckState.Passing,
                PullRequestCheckState.Failing,
              ])
              .optional(),
            acceptedReview: z.boolean().optional(),
            changedFiles: z.array(z.string().min(1)).optional(),
            watchEvent: z.literal(FakeEventType.ReviewRequested).optional(),
            eligible: z.boolean().optional(),
          })
          .strict(),
      )
      .default([]),
    deliveryEffects: z.record(z.string(), z.string()).default({}),
    effectsFile: z.string().min(1).optional(),
    // Deterministic test hook: when set, checkConnectivity rejects with this
    // message instead of resolving, so doctor's failure path is exercisable
    // without a real network dependency.
    connectivityError: z.string().min(1).optional(),
  })
  .passthrough();

export const fakeProviderDefinition: ProviderDefinition<z.output<typeof configSchema>> = {
  provider: 'fake',
  eventTypes: [],
  parseConfig(value) {
    return configSchema.parse(value);
  },
  create({ adapter, config, services }) {
    if (services === undefined) throw new Error('Fake provider requires composed services');
    return {
      adapter,
      eventTypes: [FakeEventType.WorkObserved, FakeEventType.ReviewRequested],
      source: new FakeExternalEventSource(adapter, config.events),
      delivery: new DurableFakeDeliveryProvider({
        effects: config.deliveryEffects,
        ...(config.effectsFile === undefined ? {} : { effectsFile: config.effectsFile }),
      }),
      inbound: new FakeInboundTranslator(adapter, services),
      checkConnectivity: async () => {
        if (config.connectivityError !== undefined) throw new Error(config.connectivityError);
      },
    };
  },
};

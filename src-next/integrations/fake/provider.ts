import { z } from 'zod';
import { PullRequestCheckState, ReviewActorKind } from '../../activities/index.js';
import { BuiltInResourceCapability } from '../../resources/index.js';
import { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
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
            branch: z.string().min(1).optional(),
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
            reviewActorId: z.string().min(1).optional(),
            reviewActorKind: z.enum([ReviewActorKind.Human, ReviewActorKind.Bot]).optional(),
            reviewerId: z.string().min(1).optional(),
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
    // Deterministic test hook: when set, create() throws this message instead
    // of constructing the provider, so composition's provider-construction
    // failure tolerance (e.g. missing sandbox auth) is exercisable without a
    // real credential dependency.
    createError: z.string().min(1).optional(),
  })
  .passthrough();

export const fakeProviderDefinition: ProviderDefinition<z.output<typeof configSchema>> = {
  provider: 'fake',
  eventTypes: [],
  parseConfig(value) {
    return configSchema.parse(value);
  },
  create({ adapter, config, services }) {
    if (config.createError !== undefined) throw new Error(config.createError);
    if (services === undefined) throw new Error('Fake provider requires composed services');
    return {
      adapter,
      eventTypes: [FakeEventType.WorkObserved, FakeEventType.ReviewRequested],
      source: new FakeExternalEventSource(adapter, config.events),
      delivery: new DurableFakeDeliveryProvider({
        effects: config.deliveryEffects,
        ...(config.effectsFile === undefined ? {} : { effectsFile: config.effectsFile }),
      }),
      verifyArtifact: async (kind, externalKey, context) => {
        const evidence = config.events.find((event) => event.key === externalKey.key);
        if (evidence === undefined || (evidence.kind ?? 'issue') !== 'pull-request')
          return ArtifactVerificationResult.NotFound;
        if (kind !== 'pull-request' || evidence.branch !== context.workspaceBranch)
          return ArtifactVerificationResult.NotFound;
        return {
          kind,
          externalKey,
          capabilities: [
            BuiltInResourceCapability.Reviewable,
            BuiltInResourceCapability.Approvable,
            BuiltInResourceCapability.Mergeable,
            BuiltInResourceCapability.Revisioned,
          ],
          ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
        };
      },
      inbound: new FakeInboundTranslator(adapter, services),
      checkConnectivity: async () => {
        if (config.connectivityError !== undefined) throw new Error(config.connectivityError);
      },
    };
  },
};

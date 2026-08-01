import { resourceId } from '../../resources/index.js';
import type { ProviderDefinition } from '../contracts/provider.js';
import { InboundTranslator } from './application/inbound-translator.js';
import { translateGitHubOutbound } from './application/outbound-translator.js';
import { gitHubConfigSchema, type GitHubConfig } from './contracts/config.js';
import { GitHubEventType } from './contracts/events.js';
import { createGitHubClient } from './infrastructure/client.js';
import { createGitHubDelivery } from './infrastructure/delivery.js';
import { createGitHubSource } from './infrastructure/source.js';

export const gitHubProviderDefinition: ProviderDefinition<GitHubConfig> = {
  provider: 'github',
  eventTypes: Object.values(GitHubEventType),
  parseConfig(value) {
    return gitHubConfigSchema.parse(value);
  },
  create({ adapter, config, services }) {
    if (services === undefined) throw new Error('GitHub provider requires composed services');
    const client = createGitHubClient(config.token);
    return {
      adapter,
      eventTypes: Object.values(GitHubEventType),
      source: createGitHubSource(config, client, adapter),
      delivery: createGitHubDelivery(async (intent, idempotencyKey) => {
        const resource = await services.resources.get(resourceId(intent.resourceId));
        if (resource === null)
          throw new Error(`GitHub resource ${intent.resourceId} is unavailable`);
        return client.deliver({ ...translateGitHubOutbound(resource, intent), idempotencyKey });
      }),
      inbound: new InboundTranslator(
        services.journal,
        services.checkpoints,
        services.work,
        services.resources,
        { pullRequests: services.pullRequests, ids: services.ids, adapter },
      ),
    };
  },
};

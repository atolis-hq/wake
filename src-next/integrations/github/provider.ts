import { BuiltInResourceCapability, resourceId, resourceKind } from '../../resources/index.js';
import { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
import type { ProviderDefinition } from '../contracts/provider.js';
import { InboundTranslator } from './application/inbound-translator.js';
import { translateGitHubOutbound } from './application/outbound-translator.js';
import { createGitHubWakeLabelReconciler } from './application/wake-labels.js';
import { gitHubConfigSchema, type GitHubConfig } from './contracts/config.js';
import { GitHubEventType } from './contracts/events.js';
import { createGitHubClient } from './infrastructure/client.js';
import { createGitHubDelivery } from './infrastructure/delivery.js';
import { resolveGitHubCliToken } from './infrastructure/gh-auth.js';
import { createGitHubSource } from './infrastructure/source.js';

export const gitHubProviderDefinition: ProviderDefinition<GitHubConfig> = {
  provider: 'github',
  eventTypes: Object.values(GitHubEventType),
  parseConfig(value) {
    return gitHubConfigSchema.parse(value);
  },
  create({ adapter, config, services }) {
    if (services === undefined) throw new Error('GitHub provider requires composed services');
    const client = createGitHubClient(config.token ?? resolveGitHubCliToken());
    return {
      adapter,
      eventTypes: Object.values(GitHubEventType),
      source: createGitHubSource(config, client, adapter),
      maintenance: createGitHubWakeLabelReconciler({
        orchestration: services.orchestration,
        resources: services.resources,
        getLabels: client.getIssueLabels,
        setLabels: client.setIssueLabels,
      }),
      delivery: createGitHubDelivery(async (intent, idempotencyKey) => {
        const resource = await services.resources.get(resourceId(intent.resourceId));
        if (resource === null)
          throw new Error(`GitHub resource ${intent.resourceId} is unavailable`);
        return client.deliver({ ...translateGitHubOutbound(resource, intent), idempotencyKey });
      }),
      verifyArtifact: async (kind, externalKey, context) => {
        if (kind !== resourceKind('pull-request')) return ArtifactVerificationResult.NotFound;
        const parsed = parsePullRequestKey(externalKey.key);
        if (parsed === null) return ArtifactVerificationResult.NotFound;
        try {
          const response = await client.getPullRequest(parsed.owner, parsed.repo, parsed.number);
          if (response.data.head.ref !== context.workspaceBranch)
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
            ...(response.data.head.sha === undefined ? {} : { revision: response.data.head.sha }),
          };
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            error.status === 404
          )
            return ArtifactVerificationResult.NotFound;
          return ArtifactVerificationResult.Ambiguous;
        }
      },
      inbound: new InboundTranslator(
        services.journal,
        services.checkpoints,
        services.work,
        services.resources,
        {
          pullRequests: services.pullRequests,
          ids: services.ids,
          lookup: services.resourceLookup,
          adapter,
          orchestration: services.orchestration,
          routing: services.routing,
        },
      ),
      checkConnectivity: async () => {
        await client.authenticatedLogin();
      },
    };
  },
};

function parsePullRequestKey(
  key: string,
): { readonly owner: string; readonly repo: string; readonly number: number } | null {
  const match = /^(?<owner>[^/]+)\/(?<repo>[^#]+)#(?<number>[1-9]\d*)$/.exec(key);
  if (match?.groups === undefined) return null;
  return {
    owner: match.groups.owner!,
    repo: match.groups.repo!,
    number: Number(match.groups.number),
  };
}

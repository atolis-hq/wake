import { BuiltInActivityName, PullRequestState } from '../../activities/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  resourceKind,
} from '../../resources/index.js';
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
import { createGitHubRequestCoordinator } from './infrastructure/request-coordinator.js';
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
    const requests = createGitHubRequestCoordinator({
      maxConcurrent: config.polling.maxConcurrent,
    });
    return {
      adapter,
      eventTypes: Object.values(GitHubEventType),
      source: createGitHubSource(config, client, adapter, requests, {
        checkpoints: services.checkpoints,
        now: () => services.clock.now().getTime(),
      }),
      maintenance: createGitHubWakeLabelReconciler({
        orchestration: services.orchestration,
        resources: services.resources,
        work: services.work,
        getLabels: client.getIssueLabels,
        setLabels: client.setIssueLabels,
        requests,
      }),
      delivery: createGitHubDelivery(
        async (intent, idempotencyKey) => {
          const resource = await services.resources.get(resourceId(intent.resourceId));
          if (resource === null)
            throw new Error(`GitHub resource ${intent.resourceId} is unavailable`);
          return client.deliver({
            ...translateGitHubOutbound(resource, intent, {
              publicUiUrl: services.publicUiUrl,
            }),
            idempotencyKey,
          });
        },
        async (intent) => {
          if (intent.kind !== BuiltInActivityName.IssueComplete) return null;
          const resource = await services.resources.get(resourceId(intent.resourceId));
          if (resource === null) return null;
          const parsed = parsePullRequestKey(resource.externalKey.key);
          if (parsed === null) return null;
          const issue = await client.getIssue(parsed.owner, parsed.repo, parsed.number);
          return issue.state === PullRequestState.Closed ? issue.id : null;
        },
        async (intent) => {
          try {
            const pullRequest = await services.resources.get(resourceId(intent.resourceId));
            if (pullRequest === null) return { allowed: false, reason: 'correlation-incomplete' };
            const primary = await services.resources.primaryCorrelation(pullRequest.resourceId);
            if (primary === null) return { allowed: false, reason: 'correlation-incomplete' };
            const correlated = await services.resources.correlationsForWork(primary.workItemId);
            const issues = (
              await Promise.all(
                correlated
                  .filter(
                    (value) =>
                      value.resourceId !== pullRequest.resourceId &&
                      value.role === ResourceCorrelationRole.Primary,
                  )
                  .map((value) => services.resources.get(value.resourceId)),
              )
            ).filter(
              (value): value is NonNullable<typeof value> =>
                value?.kind === BuiltInResourceKind.Issue,
            );
            if (issues.length !== 1) return { allowed: false, reason: 'correlation-incomplete' };
            const issueResource = issues[0]!;
            const pr = parsePullRequestKey(pullRequest.externalKey.key);
            const issue = parsePullRequestKey(issueResource.externalKey.key);
            if (pr === null || issue === null)
              return { allowed: false, reason: 'correlation-incomplete' };
            const [prLabels, issueLabels] = await Promise.all([
              client.getIssueLabelsFresh(pr.owner, pr.repo, pr.number),
              client.getIssueLabelsFresh(issue.owner, issue.repo, issue.number),
            ]);
            if (prLabels.includes('security')) return { allowed: false, reason: 'security-pr' };
            if (issueLabels.includes('security'))
              return { allowed: false, reason: 'security-issue' };
            return { allowed: true };
          } catch {
            return { allowed: false, reason: 'lookup-unavailable' };
          }
        },
      ),
      verifyArtifact: async (kind, externalKey, context) => {
        if (kind !== resourceKind('pull-request')) return ArtifactVerificationResult.NotFound;
        const parsed = parsePullRequestKey(externalKey.key);
        if (parsed === null) return ArtifactVerificationResult.NotFound;
        try {
          const pullRequest = await client.getPullRequest(parsed.owner, parsed.repo, parsed.number);
          if (pullRequest.head.ref !== context.workspaceBranch)
            return ArtifactVerificationResult.NotFound;
          return {
            kind,
            externalKey,
            capabilities: [
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Approvable,
              BuiltInResourceCapability.Mergeable,
              BuiltInResourceCapability.Revisioned,
              BuiltInResourceCapability.ChangedFiles,
            ],
            ...(pullRequest.head.sha === undefined ? {} : { revision: pullRequest.head.sha }),
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
          runs: services.runs,
          routing: services.routing,
          intake: config.intake,
          conclusion: services.conclusion,
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

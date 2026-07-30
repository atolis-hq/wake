import { createEventDraft, entityRef, type EventDraft } from '../../../kernel/index.js';
import type { GitHubPullRequestPayload } from '../contracts/payloads.js';

export function pullRequestObservation(input: {
  readonly repository: string;
  readonly pullRequest: GitHubPullRequestPayload;
}): EventDraft {
  const pullRequest = input.pullRequest;
  const key = `${input.repository}#${pullRequest.number}`;
  return createEventDraft({
    eventId: `github:pr:${key}:${pullRequest.updated_at}`,
    eventType: 'integration.github.work-observed',
    occurredAt: pullRequest.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${pullRequest.updated_at}`,
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: entityRef('integration', 'github'),
    payload: {
      externalKey: key,
      kind: 'pull-request',
      title: pullRequest.title,
      body: pullRequest.body ?? '',
      state: pullRequest.state,
      revision: pullRequest.head?.sha ?? pullRequest.updated_at,
      actor: {
        id: pullRequest.user?.login ?? 'unknown',
        kind: pullRequest.user?.type === 'Bot' ? 'bot' : 'human',
      },
      raw: { number: pullRequest.number },
    },
  });
}

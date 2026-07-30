import { createEventDraft, entityRef, type EventDraft } from '../../../kernel/index.js';
import type { GitHubIssuePayload } from '../contracts/payloads.js';

export function issueObservation(input: {
  readonly repository: string;
  readonly issue: GitHubIssuePayload;
}): EventDraft {
  const key = `${input.repository}#${input.issue.number}`;
  return createEventDraft({
    eventId: `github:issue:${key}:${input.issue.updated_at}`,
    eventType: 'integration.github.work-observed',
    occurredAt: input.issue.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${input.issue.updated_at}`,
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: entityRef('integration', 'github'),
    payload: {
      externalKey: key,
      kind: 'issue',
      title: input.issue.title,
      body: input.issue.body ?? '',
      state: input.issue.state,
      revision: input.issue.updated_at,
      actor: {
        id: input.issue.user?.login ?? 'unknown',
        kind: input.issue.user?.type === 'Bot' ? 'bot' : 'human',
      },
      raw: { number: input.issue.number },
    },
  });
}

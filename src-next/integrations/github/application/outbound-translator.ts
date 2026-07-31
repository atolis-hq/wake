import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import type { ResourceView } from '../../../resources/index.js';

export interface GitHubOutboundCommand {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly action: 'approve' | 'merge' | 'status' | 'reply';
  readonly idempotencyKey: string;
  readonly body?: string;
  readonly sha?: string;
  readonly merge_method?: 'merge' | 'squash' | 'rebase';
}

export function translateGitHubOutbound(
  resource: ResourceView,
  intent: DeliveryIntentView,
): GitHubOutboundCommand {
  if (resource.externalKey.adapter !== 'github')
    throw new Error('Resource is not a GitHub resource');
  const [owner, repo, number] = resource.externalKey.key.split('/');
  if (owner === undefined || repo === undefined || number === undefined || !/^\d+$/.test(number))
    throw new Error(`Invalid GitHub resource key: ${resource.externalKey.key}`);
  return {
    owner,
    repo,
    pull_number: Number(number),
    action:
      intent.kind === 'pr.approve'
        ? 'approve'
        : intent.kind === 'pr.merge'
          ? 'merge'
          : intent.kind === 'status.publish'
            ? 'status'
            : 'reply',
    idempotencyKey: intent.intentEventId,
    ...('body' in intent.payload ? { body: intent.payload.body } : {}),
    ...('revision' in intent.payload ? { sha: intent.payload.revision } : {}),
    ...(intent.payload.kind === 'pr.merge' ? { merge_method: intent.payload.method } : {}),
  };
}

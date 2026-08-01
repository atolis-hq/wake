import type { MergeMethod } from '../../../activities/index.js';
import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import { DeliveryIntentKind } from '../../delivery/contracts/vocabulary.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import type { ResourceView } from '../../../resources/index.js';
import { BuiltInResourceKind } from '../../../resources/index.js';
import { parseGitHubResourceKey } from '../contracts/external-key.js';
import {
  GitHubOutboundAction,
  type GitHubOutboundAction as GitHubOutboundActionValue,
} from '../contracts/vocabulary.js';

interface GitHubOutboundCommand {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number?: number;
  readonly pull_number?: number;
  readonly action: GitHubOutboundActionValue;
  readonly idempotencyKey: string;
  readonly body?: string;
  readonly sha?: string;
  readonly merge_method?: MergeMethod;
}

export function translateGitHubOutbound(
  resource: ResourceView,
  intent: DeliveryIntentView,
): GitHubOutboundCommand {
  if (resource.externalKey.adapter !== GitHubAdapter)
    throw new Error('Resource is not a GitHub resource');
  const { owner, repo, number } = parseGitHubResourceKey(resource.externalKey.key);
  return {
    owner,
    repo,
    ...(resource.kind === BuiltInResourceKind.PullRequest
      ? { pull_number: number }
      : { issue_number: number }),
    action: outboundAction(intent.kind),
    idempotencyKey: intent.intentEventId,
    ...('body' in intent.payload ? { body: intent.payload.body } : {}),
    ...('revision' in intent.payload ? { sha: intent.payload.revision } : {}),
    ...('method' in intent.payload ? { merge_method: intent.payload.method } : {}),
  };
}

function outboundAction(kind: DeliveryIntentView['kind']): GitHubOutboundActionValue {
  switch (kind) {
    case DeliveryIntentKind.PrApprove:
      return GitHubOutboundAction.Approve;
    case DeliveryIntentKind.PrMerge:
      return GitHubOutboundAction.Merge;
    case DeliveryIntentKind.StatusPublish:
      return GitHubOutboundAction.Status;
    case DeliveryIntentKind.ReplyPublish:
      return GitHubOutboundAction.Reply;
  }
  throw new Error(`Unknown delivery intent kind: ${kind}`);
}

import { z } from 'zod';

import type { MergeMethod } from '../../../activities/index.js';
import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import { DeliveryIntentKind } from '../../delivery/contracts/vocabulary.js';
import { BuiltInAdapterId } from '../../contracts/identifiers.js';
import type { ResourceView } from '../../../resources/index.js';
import {
  GitHubOutboundAction,
  type GitHubOutboundAction as GitHubOutboundActionValue,
} from '../contracts/vocabulary.js';

interface GitHubOutboundCommand {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
  readonly action: GitHubOutboundActionValue;
  readonly idempotencyKey: string;
  readonly body?: string;
  readonly sha?: string;
  readonly merge_method?: MergeMethod;
}

const resourceKeySchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z
    .string()
    .regex(/^\d+$/)
    .pipe(
      z.coerce
        .number<string>()
        .int()
        .positive()
        .max(9_007_199_254_740_991, 'Expected safe integer'),
    ),
]);

export function translateGitHubOutbound(
  resource: ResourceView,
  intent: DeliveryIntentView,
): GitHubOutboundCommand {
  if (resource.externalKey.adapter !== BuiltInAdapterId.GitHub)
    throw new Error('Resource is not a GitHub resource');
  const parsed = resourceKeySchema.safeParse(resource.externalKey.key.split('/'));
  if (!parsed.success)
    throw new Error(
      `Invalid GitHub resource key: ${resource.externalKey.key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      { cause: parsed.error },
    );
  const [owner, repo, pullNumber] = parsed.data;
  return {
    owner,
    repo,
    pull_number: pullNumber,
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

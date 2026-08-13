import { BuiltInActivityName } from '../../../activities/index.js';
import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';

export const DeliveryState = defineClosedVocabulary({
  Pending: 'pending',
  Confirmed: 'confirmed',
  Failed: 'failed',
  Ambiguous: 'ambiguous',
} as const);

export type DeliveryState = ValueOf<typeof DeliveryState>;

export const DeliveryResultKind = defineClosedVocabulary({
  Confirmed: 'confirmed',
  Failed: 'failed',
  Ambiguous: 'ambiguous',
  NotFound: 'not-found',
  Unknown: 'unknown',
} as const);

export type DeliveryResultKind = ValueOf<typeof DeliveryResultKind>;

export const DeliveryIntentKind = {
  PrApprove: BuiltInActivityName.PullRequestApprove,
  PrMerge: BuiltInActivityName.PullRequestMerge,
  StatusPublish: 'status.publish',
  ReplyPublish: 'reply.publish',
  AgentRunPublish: 'agent-run.publish',
} as const;

export type DeliveryIntentKind = ValueOf<typeof DeliveryIntentKind>;

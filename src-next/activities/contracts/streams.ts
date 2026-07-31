import type { Brand, EntityRef } from '../../kernel/index.js';
import type { ActivationId } from './identifiers.js';

export const ActivityStreamKind = { Decision: 'activity-decision' } as const;

export type PrAction = 'approve' | 'merge';
export type PullRequestDecisionAction = PrAction;
export type ActivityDecisionId<Action extends PrAction = PrAction> = Brand<
  string,
  `ActivityDecisionId:${Action}`
>;
export type ActivityDecisionStreamRef<Action extends PrAction = PrAction> = EntityRef<
  typeof ActivityStreamKind.Decision,
  ActivityDecisionId<Action>
>;

export const activityDecisionId = <Action extends PrAction>(
  value: string,
  action: Action,
): ActivityDecisionId<Action> => {
  if (!value.endsWith(`:pr.${action}`) || value.length === `:pr.${action}`.length) {
    throw new Error(`Invalid ${action} ActivityDecisionId: ${value}`);
  }
  return value as ActivityDecisionId<Action>;
};

export const activityDecisionStream = <Action extends PullRequestDecisionAction>(
  activation: ActivationId,
  action: Action,
): ActivityDecisionStreamRef<Action> => ({
  kind: ActivityStreamKind.Decision,
  id: activityDecisionId(`${segment(activation)}:pr.${segment(action)}`, action),
});

export const isActivityDecisionStream = (stream: EntityRef): stream is ActivityDecisionStreamRef =>
  stream.kind === ActivityStreamKind.Decision;

function segment(value: string): string {
  if (value.trim().length === 0)
    throw new Error('Activity decision stream segment must not be empty');
  return encodeURIComponent(value);
}

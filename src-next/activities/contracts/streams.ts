import type { Brand, EntityRef } from '../../kernel/index.js';
import type { ActivationId } from './identifiers.js';

export const ActivityStreamKind = { Decision: 'activity-decision' } as const;

export type PrAction = 'approve' | 'merge';
export type PullRequestDecisionAction = PrAction;
export type ActivityDecisionId = Brand<string, 'ActivityDecisionId'>;
export type ActivityDecisionStreamRef = EntityRef<
  typeof ActivityStreamKind.Decision,
  ActivityDecisionId
>;

export const activityDecisionId = (value: string): ActivityDecisionId => {
  if (!/^.+:pr\.(?:approve|merge)$/.test(value)) {
    throw new Error(`Invalid ActivityDecisionId: ${value}`);
  }
  return value as ActivityDecisionId;
};

export const activityDecisionStream = (
  activation: ActivationId,
  action: PullRequestDecisionAction,
): ActivityDecisionStreamRef => ({
  kind: ActivityStreamKind.Decision,
  id: activityDecisionId(`${segment(activation)}:pr.${segment(action)}`),
});

export const isActivityDecisionStream = (stream: EntityRef): stream is ActivityDecisionStreamRef =>
  stream.kind === ActivityStreamKind.Decision;

function segment(value: string): string {
  if (value.trim().length === 0)
    throw new Error('Activity decision stream segment must not be empty');
  return encodeURIComponent(value);
}

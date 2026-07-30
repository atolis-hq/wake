import type { EventEnvelope } from '../../../kernel/index.js';

export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly revision: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubCommentObservedPayload {
  readonly externalKey: string;
  readonly body: string;
  readonly revision: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubDeliveryObservedPayload {
  readonly deliveryId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type GitHubAdapterEvent =
  | EventEnvelope<'integration.github.work-observed', ExternalWorkObservedPayload>
  | EventEnvelope<'integration.github.comment-observed', GitHubCommentObservedPayload>
  | EventEnvelope<'integration.github.delivery-observed', GitHubDeliveryObservedPayload>;

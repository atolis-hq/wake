import type { EventEnvelope } from '../../../kernel/index.js';

export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly revision: string;
  readonly headRevision?: string;
  readonly baseRevision?: string;
  readonly checks?: 'unknown' | 'pending' | 'passing' | 'failing';
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GitHubCommentObservedPayload {
  readonly externalKey: string;
  readonly body: string;
  readonly revision: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly resourceAuthorId?: string;
  readonly authorization?:
    | { readonly source: 'configured-reviewer'; readonly reviewerId: string }
    | {
        readonly source: 'provider-permission';
        readonly permission: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';
      }
    | { readonly source: 'none' };
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

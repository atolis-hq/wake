import type { ResourceId } from '../../../resources/index.js';
import type { MergeMethod } from '../../../activities/index.js';
import type { DeliveryState as DeliveryStateValue } from './vocabulary.js';

export type DeliveryIntentKind = 'pr.approve' | 'pr.merge' | 'status.publish' | 'reply.publish';

export interface DeliveryIntentView {
  readonly intentEventId: string;
  readonly globalPosition: number;
  readonly kind: DeliveryIntentKind;
  readonly resourceId: ResourceId;
  readonly payload:
    | { readonly kind: 'pr.approve'; readonly revision: string; readonly body?: string }
    | { readonly kind: 'pr.merge'; readonly revision: string; readonly method: MergeMethod }
    | { readonly kind: 'status.publish'; readonly body: string }
    | { readonly kind: 'reply.publish'; readonly body: string };
  readonly state: DeliveryStateValue;
  readonly attempts: number;
  readonly reconciliationKey?: string;
}

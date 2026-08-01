import type { MergeMethod } from '../../../activities/index.js';
import type { EventId } from '../../../kernel/index.js';
import type { ResourceId } from '../../../resources/index.js';
import type { DeliveryIntentKind } from './vocabulary.js';
import {
  type DeliveryIntentKind as DeliveryIntentKindValue,
  type DeliveryState as DeliveryStateValue,
} from './vocabulary.js';

export interface DeliveryIntentView {
  readonly intentEventId: EventId;
  readonly globalPosition: number;
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly kind: DeliveryIntentKindValue;
  readonly resourceId: ResourceId;
  readonly payload:
    | {
        readonly kind: typeof DeliveryIntentKind.PrApprove;
        readonly revision: string;
        readonly body?: string;
      }
    | {
        readonly kind: typeof DeliveryIntentKind.PrMerge;
        readonly revision: string;
        readonly method: MergeMethod;
      }
    | { readonly kind: typeof DeliveryIntentKind.StatusPublish; readonly body: string }
    | { readonly kind: typeof DeliveryIntentKind.ReplyPublish; readonly body: string };
  readonly state: DeliveryStateValue;
  readonly attempts: number;
  readonly occurrenceOrdinal: number;
  readonly reconciliationKey?: string;
}

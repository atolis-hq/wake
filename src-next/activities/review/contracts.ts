import type { ResourceId } from '../../resources/index.js';

export interface ProposedReviewSignal {
  readonly provider: 'github';
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly providerEventId: string;
  readonly kind: 'accepted' | 'changes-requested';
}

export interface ReviewSignalInput {
  readonly provider: 'github';
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly providerEventId: string;
  readonly body: string;
}

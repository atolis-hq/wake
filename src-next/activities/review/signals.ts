import type { ProposedReviewSignal, ReviewSignalInput } from './contracts.js';

export function proposeReviewSignal(input: ReviewSignalInput): ProposedReviewSignal | null {
  const command = input.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line === '/accepted' || line === '/changes');
  if (command === undefined) return null;
  return {
    provider: input.provider,
    resourceId: input.resourceId,
    revision: input.revision,
    actorId: input.actorId,
    providerEventId: input.providerEventId,
    kind: command === '/accepted' ? 'accepted' : 'changes-requested',
  };
}

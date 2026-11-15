import type { ObservedStream } from '../../activities/index.js';
import { WorkStreamKind } from '../../work/index.js';

export function observedRetryDescription(
  observed: readonly ObservedStream[],
  exhausted = false,
): string {
  if (exhausted) return 'blocked, observed-state retries exhausted (5 retries)';
  const streams = observed.map(
    ({ stream }) =>
      `${stream.kind === WorkStreamKind.WorkItem ? 'work' : stream.kind}:${stream.id}`,
  );
  return `blocked, will retry when ${streams.join(', ')} change`;
}

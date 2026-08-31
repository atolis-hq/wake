import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { ExecutionEventType } from '../execution/index.js';
import { WorkEventType } from '../work/index.js';

export interface AnalyticsProjectionView {
  readonly events: number;
  readonly workItems: number;
  readonly runs: number;
  readonly days: Readonly<
    Record<string, { readonly events: number; readonly workItems: number; readonly runs: number }>
  >;
}

export const analyticsProjection: ProjectionDefinition<AnalyticsProjectionView> = {
  name: 'operator-analytics',
  select: () => ({ key: 'global' }),
  initial: () => ({ events: 0, workItems: 0, runs: 0, days: {} }),
  project(previous, event) {
    const day = event.event.occurredAt.slice(0, 10);
    const bucket = previous.days[day] ?? { events: 0, workItems: 0, runs: 0 };
    const workItems = event.event.eventType === WorkEventType.ItemCreated ? 1 : 0;
    const runs = event.event.eventType === ExecutionEventType.RunStarted ? 1 : 0;
    return {
      events: previous.events + 1,
      workItems: previous.workItems + workItems,
      runs: previous.runs + runs,
      days: {
        ...previous.days,
        [day]: {
          events: bucket.events + 1,
          workItems: bucket.workItems + workItems,
          runs: bucket.runs + runs,
        },
      },
    };
  },
};

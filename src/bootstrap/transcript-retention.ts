import type { TranscriptStore } from '../execution/index.js';
import type { Clock, ProjectionStore } from '../kernel/index.js';
import { WorkStatus, type WorkItemView } from '../work/index.js';
import type { ResolvedWakeModulesConfig } from './config/load-config.js';

export function createTranscriptRetention(
  transcriptStore: TranscriptStore,
  projections: ProjectionStore,
  config: ResolvedWakeModulesConfig,
  clock: Clock,
) {
  return {
    transcriptRetention: {
      async markClosedWorkItem(workItemId: string) {
        try {
          await transcriptStore.markWorkItemCleaned(
            workItemId,
            config.transcripts.retentionMs,
            clock.now().toISOString(),
          );
          return true;
        } catch (error) {
          console.error('Transcript retention failed', error);
          return false;
        }
      },
      async sweep() {
        try {
          await transcriptStore.sweepExpired(
            config.transcripts.retentionMs,
            clock.now().toISOString(),
            (_workItemId, error) => console.error('Transcript retention failed', error),
          );
        } catch (error) {
          console.error('Transcript retention failed', error);
        }
      },
    },
    closedWorkItemIds: () => closedWorkItemIds(projections),
  };
}

async function closedWorkItemIds(projections: ProjectionStore): Promise<readonly string[]> {
  return (await projections.list<WorkItemView | null>('work')).flatMap(({ value }) =>
    value?.state === WorkStatus.Closed ? [value.workItemId] : [],
  );
}

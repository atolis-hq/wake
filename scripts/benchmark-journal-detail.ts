import type { EventJournal } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../src/bootstrap/index.js';
import { toWorkItemKey } from '../src/surfaces/index.js';
import { workItemId } from '../src/work/index.js';

/** The exact filtered event application polled by the Work detail page. */
export async function createBenchmarkDetailApplication(wakeRoot: string, journal: EventJournal) {
  const root = await createCompositionRoot(wakeRoot, {
    journal,
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    config: parseRootConfig({
      schemaVersion: 1,
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'benchmark',
        workflows: {
          benchmark: {
            stages: {
              run: {
                activity: 'agent',
                requiresApproval: false,
                with: { prompt: 'Benchmark' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
    }),
  });
  const { api } = await createSurfaceApplications(root);
  return (query: Partial<Parameters<typeof api.events.list>[0]> = {}) =>
    api.events.list({
      workItemKey: toWorkItemKey(workItemId('work-00000000000000000000000001')),
      limit: 100,
      ...query,
    });
}

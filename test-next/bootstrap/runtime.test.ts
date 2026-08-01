import { describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../../src-next/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../src-next/bootstrap/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../src-next/persistence/index.js';

describe('target composition root', () => {
  it('injects only domain-owned config and central persistence ports', async () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });
    const clock = { now: () => new Date('2026-07-31T00:00:00.000Z') };
    const runtime = await createCompositionRoot('C:/wake-home', {
      config,
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      activities: new ActivityRegistry(),
    });

    expect(runtime.config.execution.defaultRunnerPool).toBe('standard');
    expect(runtime.paths.dataRoot).toContain('.wake');
    expect(runtime.projectionRunner).toBeDefined();
    expect(runtime.work).toBeDefined();
    expect(runtime.resources).toBeDefined();
    expect(runtime.orchestration).toBeDefined();
    expect(runtime.execution).toBeDefined();
  });
});

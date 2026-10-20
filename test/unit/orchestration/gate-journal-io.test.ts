import { correlationId } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { existsSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const { readdirMock, statMock } = vi.hoisted(() => ({ readdirMock: vi.fn(), statMock: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readdirMock.mockImplementation(actual.readdir);
  statMock.mockImplementation(actual.stat);
  return { ...actual, readdir: readdirMock, stat: statMock };
});

const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: correlationId(`corr-${seed}`),
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'test' },
});

// A tick runs the gate over every workflow instance. Its journal I/O must not
// grow with the number of instances, however large the history is.
it.each([false, true])(
  'gates pending activations and waits without per-instance journal reads (delegation=%s)',
  { timeout: 120_000 },
  async (delegation) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-gate-io-'));
    const journal = new FileEventJournal(root, new FakeClock());
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' };
        },
      },
    });
    const definition = compileWorkflow(
      'default',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: { done: { then: 'done' } },
            requiresApproval: false,
          },
        },
      },
      registry,
    );
    const work = createWorkService(journal);
    const service = createOrchestrationService(journal, work, { default: definition });
    const instances = 60;
    for (let index = 0; index < instances; index += 1) {
      const seed = `item-${index}`;
      await work.create({ workItemId: workId(seed), objective: seed }, context(seed));
      await service.start(
        {
          workflowInstanceId: workflowInstanceId(`workflow-${index}`),
          workItemId: workId(seed),
          workflowName: workflowName('default'),
          orchestrationGroupId: orchestrationGroupId(`group-${seed}`),
        },
        context(seed),
      );
    }
    const reader = new FileEventJournal(root, new FakeClock());
    const readerService = createOrchestrationService(
      reader,
      createWorkService(reader),
      { default: definition },
      undefined,
      undefined,
      delegation
        ? () => ({
            artifacts: {
              validateInputs: async () => {},
              registerChild: async () => {},
              qualifyingOutputs: async () => null,
            },
            runHasEnded: async () => true,
          })
        : undefined,
    );
    const segments = (await readdir(join(root, 'events'))).filter((name) =>
      name.endsWith('.jsonl'),
    ).length;
    readdirMock.mockClear();
    statMock.mockClear();

    const pending = await readerService.listPendingActivations();
    await readerService.expireTimedOutWaits(context('expire'));

    expect(pending).toHaveLength(instances);
    // One cold listing plus the gate's Work synchronisation; never one per instance.
    expect(readdirMock.mock.calls.length).toBeLessThanOrEqual(6);
    // Each segment is stat'ed once, when first seen, and never again. Probes for
    // the not-yet-written next segment stat names that do not exist.
    expect(
      statMock.mock.calls.filter(
        ([path]) => String(path).endsWith('.jsonl') && existsSync(String(path)),
      ).length,
    ).toBeLessThanOrEqual(segments);
  },
);

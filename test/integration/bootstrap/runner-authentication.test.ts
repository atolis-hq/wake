import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ClaudeAuthenticationFailureKind,
  RunnerAuthenticationMessage,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  RunnerPauseCause,
  selectControlEvent,
} from '../../../src/control-plane/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it.each([false, true])(
  'pauses authentication and resumes through the pool (fallback initially paused: %s)',
  async (fallbackPaused) => {
    const home = await mkdtemp(join(tmpdir(), 'wake-authentication-'));
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const calls: string[] = [];
    let restored = false;
    try {
      const root = await createCompositionRoot(home, {
        clock,
        journal,
        projections: new InMemoryProjectionStore(),
        checkpoints: new InMemoryCheckpointStore(),
        config: parseRootConfig({
          execution: {
            agentRunners: { preferred: { kind: 'fake' }, fallback: { kind: 'fake' } },
            runnerPools: { deep: ['preferred', 'fallback'] },
            defaultRunnerPool: 'deep',
          },
          orchestration: {
            default: 'implement',
            workflows: {
              implement: {
                stages: {
                  implement: {
                    activity: 'agent',
                    with: { prompt: 'complete work' },
                    execution: { workspace: 'none' },
                    requiresApproval: false,
                    on: { done: { then: 'done' } },
                  },
                },
              },
            },
          },
        }),
        decorateRunner(runner, name) {
          return {
            async start(request, signal) {
              calls.push(name);
              if (name === 'preferred' && !restored)
                return {
                  async cancel() {},
                  result: Promise.resolve({
                    transport: 'failed' as const,
                    output: '',
                    runner: name,
                    failure: {
                      kind: ClaudeAuthenticationFailureKind,
                      message: 'secret-provider-diagnostic',
                    },
                  }),
                };
              return runner.start(request, signal);
            },
          };
        },
      });
      const context = (id: string) => ({
        commandId: id,
        correlationId: correlationId(id),
        occurredAt: clock.now().toISOString(),
        actor: { kind: 'system' as const, id: 'test' },
      });
      const start = async (id: string) => {
        await root.work.create({ workItemId: workId(id), objective: id }, context(`${id}-work`));
        await root.orchestration.start(
          {
            workItemId: workId(id),
            workflowInstanceId: workflowInstanceId(id),
            workflowName: workflowName('implement'),
            orchestrationGroupId: orchestrationGroupId(id),
          },
          context(`${id}-start`),
        );
      };
      if (fallbackPaused) await root.runnerControls.pause('fallback', 'pause-fallback');
      await start('auth-first');
      await root.advanceOnce({ maxProgress: 1 });
      await vi.waitFor(async () =>
        expect((await root.execution.list())[0]?.outcome).toMatchObject({
          data: { reason: 'runner-authentication-required' },
        }),
      );
      await root.projectionSubscriptions.catchUpOnce();
      const { api } = await createSurfaceApplications(root);
      expect((await api.execution.runners!({ limit: 20 })).items).toContainEqual(
        expect.objectContaining({
          runnerId: 'preferred',
          available: false,
          detail: `authentication: ${RunnerAuthenticationMessage}`,
        }),
      );
      if (fallbackPaused) {
        for (let tick = 0; tick < 3; tick++) await root.advanceOnce({ maxProgress: 1 });
        expect(calls).toEqual(['preferred']);
        expect(await root.execution.list()).toHaveLength(1);
        expect(
          (await root.orchestration.get(workflowInstanceId('auth-first')))?.pendingActivation,
        ).toBeDefined();
        await root.runnerControls.unpause('fallback', 'resume-fallback');
      }
      for (let tick = 0; tick < 5 && !calls.includes('fallback'); tick++)
        await root.advanceOnce({ maxProgress: 1 });
      expect(calls).toEqual(['preferred', 'fallback']);
      expect((await root.orchestration.get(workflowInstanceId('auth-first')))?.retryCounts).toEqual(
        {},
      );
      expect(
        (await journal.readAll(0)).flatMap((envelope) => {
          const event = selectControlEvent(envelope);
          return event?.event.eventType === ControlEventType.RunnerPaused &&
            event.event.payload.cause === RunnerPauseCause.Authentication
            ? [event.event.payload]
            : [];
        }),
      ).toEqual([
        {
          runnerName: 'preferred',
          cause: RunnerPauseCause.Authentication,
          reason: RunnerAuthenticationMessage,
        },
      ]);
      clock.advance(24 * 60 * 60_000);
      await start('auth-later');
      await root.advanceOnce({ maxProgress: 1 });
      expect(calls.filter((name) => name === 'preferred')).toHaveLength(1);
      restored = true;
      await root.runnerControls.unpause('preferred', 'credentials-restored');
      await start('auth-restored');
      for (
        let tick = 0;
        tick < 8 && calls.filter((name) => name === 'preferred').length < 2;
        tick++
      )
        await root.advanceOnce({ maxProgress: 1 });
      expect(calls.filter((name) => name === 'preferred')).toHaveLength(2);
      expect(JSON.stringify(await journal.readAll(0))).not.toContain('secret-provider-diagnostic');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

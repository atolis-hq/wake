import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { RunnerAuthenticationMessage } from '../../../src/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import { createClaudeRunner } from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it('removes a real structured authentication diagnostic from persistent transcripts and journal reporting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-auth-transcripts-'));
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const id = workId('auth-transcripts');
  const context = {
    commandId: 'create',
    correlationId: correlationId('auth-transcripts'),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
  let cleanup: Awaited<ReturnType<typeof createCompositionRoot>> | undefined;
  try {
    const root = await createCompositionRoot(home, {
      clock,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      config: parseRootConfig({
        transcripts: { enabled: true },
        execution: {
          agentRunners: { claude: { kind: 'fake' } },
          runnerPools: { standard: ['claude'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: {
          default: 'implement',
          workflows: {
            implement: {
              stages: {
                implement: {
                  activity: 'agent',
                  with: { prompt: 'auth-error-secret' },
                  execution: { workspace: 'none' },
                  requiresApproval: false,
                  on: { done: { then: 'done' } },
                },
              },
            },
          },
        },
      }),
      decorateRunner: () =>
        createClaudeRunner({
          command: fileURLToPath(
            new URL('../execution/fixtures/claude-progress.cjs', import.meta.url),
          ),
        }),
    });
    cleanup = root;
    await root.work.create(
      { workItemId: id, objective: 'exercise real CLI authentication' },
      context,
    );
    await root.orchestration.start(
      {
        workItemId: id,
        workflowInstanceId: workflowInstanceId('auth-transcripts'),
        workflowName: workflowName('implement'),
        orchestrationGroupId: orchestrationGroupId('auth-transcripts'),
      },
      { ...context, commandId: 'start' },
    );
    await root.advanceOnce({ maxProgress: 1 });
    await vi.waitFor(async () =>
      expect((await root.execution.list())[0]?.outcome).toMatchObject({
        data: { reason: 'runner-authentication-required' },
      }),
    );
    const groups = await root.transcriptStore!.listGroups(id);
    expect(groups).toHaveLength(1);
    const messages = await root.transcriptStore!.readGroup(id, groups[0]!.id);
    expect(messages.find((message) => message.kind === 'response')?.text).toBe(
      RunnerAuthenticationMessage,
    );
    expect(JSON.stringify(messages)).not.toContain('AUTH_SENTINEL_SECRET');
    expect(JSON.stringify(await journal.readAll(0))).not.toContain('AUTH_SENTINEL_SECRET');
  } finally {
    await cleanup?.execution.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

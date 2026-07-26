import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { runAuditCommand } from '../../src/cli/audit-command.js';
import { AUTONOMOUS_DECISION_AUDIT_EVENT } from '../../src/domain/schema.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

describe('wake audit', () => {
  let wakeRoot: string;
  let stateStore: ReturnType<typeof createStateStore>;

  beforeEach(async () => {
    wakeRoot = await mkdtemp(join(tmpdir(), 'wake-audit-'));
    stateStore = createStateStore({ wakeRoot });
    await stateStore.ensureWakeRoot();
  });

  it('prints autonomous decisions from append-only events after projection state is deleted', async () => {
    await stateStore.appendEventEnvelope(
      createEventEnvelope({
        eventId: 'audit-1',
        workItemKey: 'work-01JZAUDIT000000000000000',
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: AUTONOMOUS_DECISION_AUDIT_EVENT,
        sourceRefs: { runId: 'run-1' },
        occurredAt: '2026-07-25T12:00:00.000Z',
        ingestedAt: '2026-07-25T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          decisionType: 'review.verdict',
          workItemId: 'work-01JZAUDIT000000000000000',
          runId: 'run-1',
          workflowRevision: 'sha256:test',
          inputsConsidered: { sourceRevision: 'issue@1' },
          outcome: { verdict: 'approved', reasoning: 'Safe to merge.' },
          timestamp: '2026-07-25T12:00:00.000Z',
        },
      }),
    );
    await rm(join(stateStore.paths.dataRoot, 'state'), { recursive: true, force: true });

    const lines: string[] = [];
    await runAuditCommand({
      args: ['work-01JZAUDIT000000000000000'],
      stateStore,
      log: (message) => lines.push(message),
    });

    expect(lines.join('\n')).toContain(
      'Autonomous audit history for work-01JZAUDIT000000000000000',
    );
    expect(lines.join('\n')).toContain('review.verdict');
    expect(lines.join('\n')).toContain('"verdict":"approved"');
  });
});

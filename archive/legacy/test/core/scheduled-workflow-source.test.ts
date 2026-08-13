import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createEventResolver } from '../../src/core/event-resolver.js';
import { createPolicyEngine } from '../../src/core/policy-engine.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createScheduledWorkflowSource } from '../../src/core/scheduled-workflow-source.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { AUTONOMOUS_DECISION_AUDIT_EVENT } from '../../src/domain/schema.js';
import type { IssueStateRecord } from '../../src/domain/types.js';
import { chooseAction } from '../../src/domain/workflows.js';

describe('scheduled workflow source', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-scheduled-source-'));
  });

  it('emits one deterministic synthetic intake event per elapsed cron slot', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.workflows = {
      triage: {
        trigger: { schedule: { cron: '*/10 * * * *' } },
        stages: {
          assign: { action: 'triage-assign', workspace: 'none', onDone: 'done' },
        },
      },
    };
    const source = createScheduledWorkflowSource({
      config,
      stateStore: store,
      now: () => new Date('2026-07-25T22:34:30.000Z'),
    });

    const first = await source.pollEvents();
    const duplicate = await source.pollEvents();

    expect(first).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.eventId).toBe(first[0]?.eventId);
    expect(first[0]?.sourceEventType).toBe('ticket.upsert');
    expect(first[0]?.payload.workflow).toBe('triage');
    expect(first[0]?.payload.trigger).toMatchObject({
      kind: 'schedule',
      slot: '2026-07-25T22:30:00.000Z',
      idempotencyKey: first[0]?.eventId,
    });
  });

  it('advances durable trigger state only after the firing event exists', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.workflows = {
      triage: {
        trigger: { schedule: { cron: '*/10 * * * *' } },
        stages: {
          assign: { action: 'triage-assign', workspace: 'none', onDone: 'done' },
        },
      },
    };
    const resourceIndex = createFakeResourceIndex();
    const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex, config });
    const resolver = createEventResolver({
      clock: { now: () => new Date('2026-07-25T22:34:31.000Z') },
      config,
      stateStore: store,
      resourceIndex,
      projectionUpdater,
      qualifiesForMint: createPolicyEngine().qualifiesForMint,
    });
    const source = createScheduledWorkflowSource({
      config,
      stateStore: store,
      now: () => new Date('2026-07-25T22:34:30.000Z'),
    });

    const [event] = await source.pollEvents();
    expect(event).toBeDefined();
    await resolver.ingestInboundEvents([event!]);

    const afterAppend = await source.pollEvents();
    const afterStateAdvance = await source.pollEvents();
    const projection = (await store.listIssueStates())[0];

    expect(afterAppend).toEqual([]);
    expect(afterStateAdvance).toEqual([]);
    expect(projection?.context.workflow).toBe('triage');
    expect(projection?.wake.stage).toBe('queue');
  });

  it('does not dispatch scheduled triage while the scheduler WIP slot is occupied', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.workflows = {
      triage: {
        trigger: { schedule: { cron: '*/10 * * * *' } },
        stages: {
          assign: { action: 'triage-assign', workspace: 'none', onDone: 'done' },
        },
      },
    };
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-active',
      workItemKey: 'work-01JZ0000000000000000000000',
      repo: 'org/repo',
      issueNumber: 1,
      action: 'implement',
      lifecycle: 'RUNNING',
      status: 'running',
      startedAt: '2026-07-25T22:00:00.000Z',
      lease: {
        leaseId: 'lease-active',
        ownerInstanceId: 'other-instance',
        acquiredAt: '2026-07-25T22:00:00.000Z',
        lastRenewedAt: '2026-07-25T22:34:00.000Z',
        expiresAt: '2026-07-25T22:45:00.000Z',
      },
    });
    let runnerCalls = 0;

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-25T22:34:30.000Z') },
      config,
      stateStore: store,
      workSource: createScheduledWorkflowSource({
        config,
        stateStore: store,
        now: () => new Date('2026-07-25T22:34:30.000Z'),
      }),
      runner: {
        async run() {
          runnerCalls += 1;
          return { result: 'assigned\nDONE', model: 'test', cli: 'test' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      resourceIndex: createFakeResourceIndex(),
    });

    await tickRunner.runTick();

    expect(runnerCalls).toBe(0);
    expect(await store.listIssueStates()).toHaveLength(1);
    const auditEvent = (await store.listEventEnvelopes()).find(
      (event) => event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT,
    );
    expect(auditEvent?.payload).toMatchObject({
      decisionType: 'trigger.fired',
      workItemId: auditEvent?.workItemKey,
      workflowRevision: expect.stringMatching(/^sha256:/),
      outcome: expect.objectContaining({ fired: true }),
    });
  });

  it('keeps scheduled workflow stage prompt context on the selected action', () => {
    const config = createDefaultWakeConfig(root);
    config.workflows = {
      triage: {
        trigger: { schedule: { cron: '*/10 * * * *' } },
        stages: {
          assign: {
            action: 'triage-assign',
            workspace: 'none',
            onDone: 'done',
            promptContext: {
              triageCapacityAvailable: true,
              triageReposJson: '["org/repo"]',
            },
          },
        },
      },
    };
    const projection: IssueStateRecord = {
      schemaVersion: 1,
      workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A99',
      issue: {
        repo: 'wake/internal',
        number: 1,
        title: 'Scheduled workflow: triage',
        body: 'Synthetic schedule trigger',
        labels: ['wake:scheduled-workflow'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://wake.local/schedules/triage/slot',
        createdAt: '2026-07-25T22:30:00.000Z',
        updatedAt: '2026-07-25T22:30:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-25T22:34:00.000Z',
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: { workflow: 'triage' },
      correlatedResources: [],
    };

    expect(chooseAction(projection, config.workflows.triage!)?.promptContext).toMatchObject({
      triageCapacityAvailable: true,
      triageReposJson: '["org/repo"]',
    });
  });
});

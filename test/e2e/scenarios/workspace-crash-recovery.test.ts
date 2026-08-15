import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activationId,
  activityName,
} from '../../../src/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import {
  ExecutionEventType,
  WorkspaceMode,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import { EventActorKind, EventSourceKind, createEventDraft } from '../../../src/kernel/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-001',
    title: 'a restarted root reclaims only a never-started owned workspace',
    given: [
      'ownership markers and matching workspace directories from a crashed process',
      'one never-started owner, one Started owner, and one Ambiguous owner',
    ],
    when: ['a fresh composition root advances its recovery pass'],
    then: [
      'the never-started workspace and marker are removed before dispatch',
      'the Started and Ambiguous workspaces and markers remain intact',
    ],
  },
  async () => {
    const wakeRoot = await createWakeRoot();
    const first = await createCompositionRoot(wakeRoot);
    await appendRun(first, 'started', ExecutionEventType.RunStarted);
    await appendRun(first, 'ambiguous', ExecutionEventType.RunAmbiguous);
    await persistWorkspace(first.paths.workspacesRoot, 'orphan', 'orphan');
    await persistWorkspace(first.paths.workspacesRoot, 'started', 'started');
    await persistWorkspace(first.paths.workspacesRoot, 'ambiguous', 'ambiguous');

    const restarted = await createCompositionRoot(wakeRoot);
    await restarted.advanceOnce({ maxProgress: 1 });

    await expect(
      access(workspacePath(restarted.paths.workspacesRoot, 'orphan')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(markerPath(restarted.paths.workspacesRoot, 'orphan')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(workspacePath(restarted.paths.workspacesRoot, 'started')),
    ).resolves.toBeUndefined();
    await expect(
      access(markerPath(restarted.paths.workspacesRoot, 'started')),
    ).resolves.toBeUndefined();
    await expect(
      access(workspacePath(restarted.paths.workspacesRoot, 'ambiguous')),
    ).resolves.toBeUndefined();
    await expect(
      access(markerPath(restarted.paths.workspacesRoot, 'ambiguous')),
    ).resolves.toBeUndefined();
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-003',
    title: 'workspace recovery completes before a runnable activation is dispatched',
    given: ['a restarted root with a never-started owned workspace and one pending activation'],
    when: ['the root advances once'],
    then: ['the activation observes that recovery has already reclaimed the owned workspace'],
  },
  async () => {
    const wakeRoot = await createWakeRoot();
    const activities = recoveryOrderingActivities(wakeRoot);
    const config = recoveryOrderingConfig();
    const first = await createCompositionRoot(wakeRoot, { activities, config });
    await persistWorkspace(first.paths.workspacesRoot, 'orphan', 'orphan');
    const context = commandContext('workspace-ordering');
    const work = await first.work.create(
      { workItemId: workId('workspace-ordering'), objective: 'prove recovery ordering' },
      context,
    );
    await first.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workspace-ordering'),
        workItemId: work.workItemId,
        workflowName: 'default' as never,
        orchestrationGroupId: orchestrationGroupId('workspace-ordering'),
      },
      context,
    );

    const restarted = await createCompositionRoot(wakeRoot, { activities, config });
    expect((await restarted.advanceOnce({ maxProgress: 1 })).kind).toBe('progressed');
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-002',
    title: 'maintenance prevents tick-driven workspace recovery',
    given: ['a fresh root with a never-started owned workspace and an active maintenance lease'],
    when: ['advance-once runs while maintenance is active'],
    then: ['the workspace remains until maintenance clears and a later tick recovers it'],
  },
  async () => {
    const wakeRoot = await createWakeRoot();
    const first = await createCompositionRoot(wakeRoot);
    await persistWorkspace(first.paths.workspacesRoot, 'maintenance-orphan', 'maintenance-orphan');
    const restarted = await createCompositionRoot(wakeRoot);
    await restarted.maintenance.acquire('v2');

    expect(await restarted.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    await expect(
      access(workspacePath(restarted.paths.workspacesRoot, 'maintenance-orphan')),
    ).resolves.toBeUndefined();

    await restarted.maintenance.clear();
    await restarted.advanceOnce({ maxProgress: 1 });
    await expect(
      access(workspacePath(restarted.paths.workspacesRoot, 'maintenance-orphan')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
  10_000,
);

async function createWakeRoot(): Promise<string> {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-workspace-recovery-e2e-'));
  roots.push(wakeRoot);
  await mkdir(join(wakeRoot, 'provider'), { recursive: true });
  await writeFile(join(wakeRoot, 'config.yaml'), fixtureConfig);
  await writeFile(join(wakeRoot, 'provider', 'evidence.json'), '[]\n');
  return wakeRoot;
}

async function persistWorkspace(
  root: string,
  workspaceId: string,
  ownerRunId: string,
): Promise<void> {
  const path = workspacePath(root, workspaceId);
  await mkdir(path, { recursive: true });
  await mkdir(join(root, '.wake-workspace-ownership'), { recursive: true });
  await writeFile(
    markerPath(root, workspaceId),
    JSON.stringify({
      runId: ownerRunId,
      workItemId: `work-${workspaceId}`,
      repositoryResourceId: `resource-${workspaceId}`,
      mode: WorkspaceMode.Branch,
      workspaceId,
      path,
    }),
  );
}

function workspacePath(root: string, workspaceId: string): string {
  return join(root, workspaceId);
}

function markerPath(root: string, workspaceId: string): string {
  return join(root, '.wake-workspace-ownership', `${workspaceId}.json`);
}

async function appendRun(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  id: string,
  eventType: typeof ExecutionEventType.RunStarted | typeof ExecutionEventType.RunAmbiguous,
): Promise<void> {
  if (eventType === ExecutionEventType.RunAmbiguous) {
    await appendRun(root, id, ExecutionEventType.RunStarted);
    await appendAmbiguous(root, id);
    return;
  }
  const currentRunId = runId(id);
  const occurredAt = '2026-08-11T00:00:00.000Z';
  await root.journal.append(runStream(currentRunId), 0, [
    createEventDraft({
      eventId: `${id}:${eventType}`,
      eventType,
      occurredAt,
      correlationId: `group-${id}`,
      causationId: `activation-${id}`,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream: runStream(currentRunId),
      payload: {
        activationId: activationId(`activation-${id}`),
        activity: activityName('fake'),
        workflowInstanceId: workflowInstanceId(`workflow-${id}`),
        orchestrationGroupId: orchestrationGroupId(`group-${id}`),
        attempt: 1,
        startedAt: occurredAt,
      },
    }),
  ]);
}

async function appendAmbiguous(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  id: string,
): Promise<void> {
  const currentRunId = runId(id);
  const occurredAt = '2026-08-11T00:00:00.000Z';
  await root.journal.append(runStream(currentRunId), 1, [
    createEventDraft({
      eventId: `${id}:${ExecutionEventType.RunAmbiguous}`,
      eventType: ExecutionEventType.RunAmbiguous,
      occurredAt,
      correlationId: `group-${id}`,
      causationId: `activation-${id}`,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream: runStream(currentRunId),
      payload: { reason: 'recovery needs an operator', finishedAt: occurredAt },
    }),
  ]);
}

const fixtureConfig = `schemaVersion: 1
execution:
  agentRunners:
    fake: { kind: fake, timeoutMs: 5000 }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
controlPlane: {}
integrations:
  fake:
    provider: fake
    enabled: true
    evidenceFile: provider/evidence.json
    effectsFile: provider/effects.json
surfaces:
  api: { enabled: false }
  web: { enabled: false }
`;

function recoveryOrderingActivities(wakeRoot: string): ActivityRegistry {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('assert-workspace-recovery'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      execute: async () => {
        await expect(access(join(wakeRoot, 'workspaces', 'orphan'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        return { kind: ActivityOutcomeKind.Done };
      },
    },
  });
  return activities;
}

function recoveryOrderingConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    activities: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      workflows: {
        default: {
          stages: {
            assert: {
              activity: 'assert-workspace-recovery',
              with: {},
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

function commandContext(id: string) {
  return {
    commandId: id,
    correlationId: id as never,
    occurredAt: '2026-08-11T00:00:00.000Z',
    actor: { kind: EventActorKind.System, id: 'test' },
  };
}

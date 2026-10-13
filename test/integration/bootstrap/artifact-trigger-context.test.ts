import { EventSourceKind, correlationId } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactContextEventType,
  ArtifactContextService,
  ArtifactMemoryPublicationReason,
  artifactContextStream,
} from '../../../src/artifacts/index.js';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  TriggerSourceKind,
  createControlPlaneEventData,
  selectControlEvent,
  triggerInvocationStream,
} from '../../../src/control-plane/index.js';
import {
  OrchestrationEventType,
  createOrchestrationEventData,
  orchestrationGroupId,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
} from '../../../src/orchestration/index.js';
import { ArtifactMcpRunner } from '../../support/artifact-mcp-runner.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = () => ({
  commandId: `test-${Math.random()}`,
  correlationId: correlationId('artifact-trigger'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'test' },
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wake-artifact-triggers-'));
  homes.push(home);
  const runner = new ArtifactMcpRunner();
  const journal = new FaultInjectingJournal({ now: () => new Date() });
  const config = parseRootConfig({
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'inspect',
      workflows: {
        inspect: {
          stages: {
            produce: {
              activity: 'agent',
              requiresApproval: false,
              with: { prompt: 'Write selected shared context' },
              execution: { workspace: 'none' },
              on: { done: { then: 'done' }, failed: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {
      triggers: [
        {
          id: 'shared',
          workflow: 'inspect',
          contextScope: 'review',
          on: { events: ['work.objective-revised'] },
        },
        { id: 'unrelated', workflow: 'inspect', on: { events: ['work.objective-revised'] } },
      ],
    },
  });
  const restart = async () => {
    const root = await createCompositionRoot(home, {
      config,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateRunner: () => runner,
    });
    runner.root = root;
    return root;
  };
  return { root: await restart(), restart, runner, journal, config };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

let occurrence = 0;

async function start(f: Fixture, root = f.root, id = 'shared') {
  await root.triggers.start(
    f.config.controlPlane.triggers.find((trigger) => trigger.id === id)!,
    {
      kind: TriggerSourceKind.Cron,
      slot: new Date(Date.UTC(2026, 0, 1, 0, ++occurrence)).toISOString(),
    },
    context(),
  );
  const starts = (await f.journal.readAll(0))
    .map(selectControlEvent)
    .flatMap((event) =>
      event?.event.eventType === ControlEventType.TriggerInvocationStarted
        ? [event.event.payload]
        : [],
    );
  return (await root.orchestration.get(workflowInstanceId(starts.at(-1)!.workflowInstanceId)))!;
}

async function execute(root: CompositionRoot, workflow: Awaited<ReturnType<typeof start>>) {
  const activation = workflow.pendingActivation!;
  await root.execution.attempt(activation, {
    workItemId: workflow.workItemId,
    workflowInstanceId: workflow.workflowInstanceId,
    orchestrationGroupId: workflow.orchestrationGroupId,
    resources: [],
  });
  await vi.waitFor(async () =>
    expect((await root.execution.list(activation.activationId))[0]?.outcome).toBeDefined(),
  );
  const run = (await root.execution.list(activation.activationId))[0]!;
  return root.orchestration.acceptOutcome(
    {
      workflowInstanceId: workflow.workflowInstanceId,
      activationId: activation.activationId,
      outcome: run.outcome!,
    },
    context(),
  );
}

const write = (path: string, content: string, share = false) => ({
  name: 'wake_artifacts_write',
  arguments: { path, content, share },
});
const contexts = (root: CompositionRoot) =>
  new ArtifactContextService(root.journal, root.artifacts);

describe('composed trigger artifact context', () => {
  it('hands selected exports and memory to a new run/session after restart, with private and unrelated access denied', async () => {
    const f = await fixture();
    const first = await start(f);
    f.runner.scripts.push({
      operations: [
        write('memory.md', 'prior memory'),
        write('report.md', 'selected', true),
        write('private.md', 'private'),
      ],
    });
    await execute(f.root, first);
    // Simulate restart between durable acceptance and publication.
    const recovered = await f.restart();
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    const view = await contexts(recovered).get('review');
    expect(view.publications).toHaveLength(1);
    const memory = view.memory!;
    const report = (await recovered.artifacts.get(first.workItemId))!.revisions.find(
      (revision) => revision.path === 'report.md',
    )!;
    const second = await start(f, recovered);
    f.runner.scripts.push({
      operations: [
        { name: 'wake_artifacts_read', arguments: { ...memory } },
        {
          name: 'wake_artifacts_read',
          arguments: { revisionId: report.revisionId, workItemId: first.workItemId },
        },
        {
          name: 'wake_artifacts_patch',
          arguments: { revisionId: report.revisionId, find: 'selected', replace: 'forbidden' },
        },
        write('report.md', 'local private'),
      ],
    });
    await execute(recovered, second);
    expect(f.runner.sessions[1]!.manifest).toContain('currentMemory');
    expect(f.runner.sessions[1]!.prompt).toContain(report.revisionId);
    expect(f.runner.sessions[1]!.manifest).not.toContain('private.md');
    expect(f.runner.sessions[1]!.results).toMatchObject([
      { content: [{ text: 'prior memory' }] },
      { content: [{ text: 'selected' }] },
      { isError: true },
      {},
    ]);
    expect((await recovered.artifacts.get(second.workItemId))!.revisions[0]).toMatchObject({
      path: 'report.md',
    });
    await recovered.runnerPipeline.run({ maxProgress: 1 });
    const unrelated = await start(f, recovered, 'unrelated');
    f.runner.scripts.push({
      operations: [
        { name: 'wake_artifacts_read', arguments: { ...memory } },
        write('export.md', 'deny self-enrollment', true),
      ],
    });
    await execute(recovered, unrelated);
    expect(f.runner.sessions[2]!.manifest).not.toContain(memory.revisionId);
    expect(f.runner.sessions[2]!.results).toMatchObject([{ isError: true }, { isError: true }]);
    expect((await contexts(recovered).get('review')).members).not.toContainEqual(
      expect.objectContaining({ workItemId: unrelated.workItemId }),
    );
  });

  it('records stale-pointer rejection without blocking unrelated triggers and ignores extra workflows on a claimed WorkItem', async () => {
    const f = await fixture();
    const first = await start(f);
    f.runner.scripts.push({ operations: [write('memory.md', 'first')] });
    await execute(f.root, first);
    // The trigger finish can survive before its artifact publication; enroll the next invocation in this window.
    await f.root.triggers.reconcile(context());
    const second = await start(f);
    f.runner.scripts.push({ operations: [write('memory.md', 'second')] });
    await execute(f.root, second);
    const extra = await f.root.orchestration.start(
      {
        workItemId: first.workItemId,
        workflowInstanceId: workflowInstanceId('extra-workflow'),
        workflowName: workflowName('inspect'),
        orchestrationGroupId: first.orchestrationGroupId,
        parentWorkflowInstanceId: first.workflowInstanceId,
        watchId: 'test-watch',
        triggerId: 'test-child',
        causalCycleId: 'test-cycle',
        requestId: 'extra-workflow',
      },
      context(),
    );
    f.runner.scripts.push({ operations: [] });
    await execute(f.root, extra);
    await expect(f.root.runnerPipeline.run({ maxProgress: 1 })).resolves.toBeDefined();
    const view = await contexts(f.root).get('review');
    expect(view.publications.map((publication) => publication.reason)).toEqual([
      ArtifactMemoryPublicationReason.Advanced,
      ArtifactMemoryPublicationReason.Conflict,
    ]);
    expect(view.memory?.workItemId).toBe(first.workItemId);
    const before = await f.journal.readStream(artifactContextStream('review'));
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect(await f.journal.readStream(artifactContextStream('review'))).toEqual(before);
    const unrelated = await start(f, f.root, 'unrelated');
    await execute(f.root, unrelated);
    await expect(f.root.runnerPipeline.run({ maxProgress: 1 })).resolves.toBeDefined();
  });

  it.each(['before', 'after'] as const)(
    'recovers a %s-publication append crash while other triggers continue',
    async (window) => {
      const f = await fixture();
      const first = await start(f);
      f.runner.scripts.push({ operations: [write('memory.md', 'recover')] });
      await execute(f.root, first);
      if (window === 'before') f.journal.failBefore = ArtifactContextEventType.Published;
      else f.journal.failAfter = ArtifactContextEventType.Published;
      await expect(f.root.runnerPipeline.run({ maxProgress: 1 })).resolves.toBeDefined();
      const root = await f.restart();
      await root.runnerPipeline.run({ maxProgress: 1 });
      await root.runnerPipeline.run({ maxProgress: 1 });
      const view = await contexts(root).get('review');
      expect(view.publications).toHaveLength(1);
      expect(view.memory?.workItemId).toBe(first.workItemId);
    },
  );

  it('does not advance memory from failed invocations', async () => {
    const f = await fixture();
    const workflow = await start(f);
    f.runner.scripts.push({ operations: [write('memory.md', 'failure')], outcome: 'FAILED' });
    await execute(f.root, workflow);
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect((await contexts(f.root).get('review')).publications).toMatchObject([
      { reason: ArtifactMemoryPublicationReason.Failed, memory: null },
    ]);
  });
  it('denies enrollment without a durable claim matching the configured coordination key', async () => {
    const f = await fixture();
    const first = await start(f);
    f.runner.scripts.push({ operations: [write('memory.md', 'shared memory')] });
    await execute(f.root, first);
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    const memory = (await contexts(f.root).get('review')).memory!;
    const claimless = workflowInstanceId('claimless');
    const { workId } = await import('../../support/identities.js');
    const item = workId('claimless');
    await f.root.work.create(
      { workItemId: item, objective: 'Agent claims a shared name' },
      context(),
    );
    const manual = await f.root.orchestration.start(
      {
        workItemId: item,
        workflowInstanceId: claimless,
        workflowName: workflowName('inspect'),
        orchestrationGroupId: orchestrationGroupId('claimless-group'),
      },
      context(),
    );
    f.runner.scripts.push({
      operations: [
        write('memory.md', 'private', true),
        { name: 'wake_artifacts_read', arguments: { ...memory, contextScope: 'review' } },
      ],
    });
    await execute(f.root, manual);
    expect(f.runner.sessions.at(-1)!.results).toMatchObject([{ isError: true }, { isError: true }]);
    expect((await contexts(f.root).get('review')).members).not.toContainEqual(
      expect.objectContaining({ workItemId: item }),
    );
    // A sole mismatched trusted claim also grants nothing, even though its trigger ID exists.
    const manualStream = triggerInvocationStream(item);
    await f.journal.appendToStream(manualStream, 0, [
      createControlPlaneEventData({
        ...context(),
        causationId: 'test',
        eventId: 'mismatched-binding',
        eventType: ControlEventType.TriggerInvocationClaimed,
        source: { kind: EventSourceKind.Internal, id: 'test-invalid-binding' },
        payload: {
          triggerId: 'shared',
          coordinationKey: 'context:other',
          workItemId: item,
          workflowInstanceId: manual.workflowInstanceId,
          workflowName: 'inspect',
          source: { kind: TriggerSourceKind.Cron, slot: '2026-01-01T00:00:00.000Z' },
          sources: [{ kind: TriggerSourceKind.Cron, slot: '2026-01-01T00:00:00.000Z' }],
        },
      }),
    ]);
    const restarted = await f.restart();
    await restarted.runnerPipeline.run({ maxProgress: 1 });
    expect((await contexts(restarted).get('review')).members).not.toContainEqual(
      expect.objectContaining({ workItemId: item }),
    );
  });

  it('records superseded invocations without publishing their draft memory', async () => {
    const f = await fixture();
    const workflow = await start(f);
    f.runner.scripts.push({ operations: [write('memory.md', 'draft')] });
    await f.root.execution.attempt(workflow.pendingActivation!, {
      workItemId: workflow.workItemId,
      workflowInstanceId: workflow.workflowInstanceId,
      orchestrationGroupId: workflow.orchestrationGroupId,
      resources: [],
    });
    await vi.waitFor(async () => expect((await f.root.execution.list())[0]?.outcome).toBeDefined());
    const stream = workflowInstanceStream(workflow.workflowInstanceId);
    await f.journal.appendToStream(stream, (await f.journal.readStream(stream)).length, [
      createOrchestrationEventData({
        ...context(),
        causationId: 'test',
        eventId: 'superseded',
        eventType: OrchestrationEventType.InstanceSuperseded,
        source: { kind: EventSourceKind.Internal, id: 'orchestration-test' },
        payload: {},
      }),
    ]);
    await f.root.runnerPipeline.run({ maxProgress: 1 });
    expect((await contexts(f.root).get('review')).publications).toMatchObject([
      { reason: ArtifactMemoryPublicationReason.Failed, memory: null, references: [] },
    ]);
  });

  it('reserves delegation stream names from operator-configured shared scopes', () => {
    expect(() =>
      parseRootConfig({
        controlPlane: {
          triggers: [
            {
              id: 'unsafe',
              workflow: 'inspect',
              contextScope: 'delegation:parent',
              on: { events: ['work.objective-revised'] },
            },
          ],
        },
      }),
    ).toThrow('reserved');
  });
});

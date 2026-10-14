import { EventActorKind, EventSourceKind, correlationId } from '@atolis-hq/eventing';
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
  operatorInstructionsProjection,
} from '../../../src/artifacts/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
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
import { workId } from '../../support/identities.js';

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

it('edits through the operator API, keeps an active run snapshot, audits it and delivers the next revision after restart', async () => {
  const f = await fixture();
  const applications = await createSurfaceApplications(f.root);
  const dispatcher = (await import('../../../src/surfaces/index.js')).createApiDispatcher(
    applications.api,
  );
  const save = (
    id: string,
    content: string,
    expectedRevisionId: string | null,
    idempotencyKey: string,
  ) =>
    dispatcher.dispatch('POST', `/api/v1/triggers/${id}/commands/instructions`, {
      content,
      expectedRevisionId,
      idempotencyKey,
    });
  expect((await save('unrelated', 'No invented scope', null, 'no-scope'))?.status).toBe(409);
  expect((await save('shared', 'Only pick issues labelled ready.', null, 'first'))?.status).toBe(
    200,
  );
  const detail = await applications.api.triggers!.detail('shared');
  const firstRevision = detail!.data.operatorInstructions!.revisionId;
  expect(detail!.data.operatorInstructions).toMatchObject({
    author: 'web',
    content: 'Only pick issues labelled ready.',
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.runner.scripts.push({ hold, operations: [{ name: 'wake_context_instructions_read' }] });
  const first = await start(f);
  const execution = execute(f.root, first);
  await vi.waitFor(() => expect(f.runner.sessions).toHaveLength(1));
  expect(f.runner.sessions[0]!.prompt).toContain('## Trusted operator standing instructions');
  expect(f.runner.sessions[0]!.prompt).toContain('Only pick issues labelled ready.');
  expect(f.runner.sessions[0]!.prompt).toContain('tool allowlist remain higher authority');
  expect(
    (await save('shared', 'Only pick issues labelled urgent.', firstRevision, 'second'))?.status,
  ).toBe(200);
  expect((await save('shared', 'Stale replacement', firstRevision, 'stale'))?.status).toBe(409);
  release();
  await execution;
  expect(JSON.stringify(f.runner.sessions[0]!.results)).toContain(
    'Only pick issues labelled ready.',
  );
  const run = (await f.root.execution.list(first.pendingActivation!.activationId))[0]!;
  expect(run.operatorInstructions).toEqual({ contextScope: 'review', revisionId: firstRevision });
  await f.root.projectionSubscriptions.catchUpOnce();
  expect(
    (await applications.api.execution.get!(run.runId))?.data.operatorInstructions,
  ).toMatchObject({ revisionId: firstRevision, content: 'Only pick issues labelled ready.' });
  const restarted = await f.restart();
  const second = await start(f, restarted);
  await execute(restarted, second);
  expect(f.runner.sessions[1]!.prompt).toContain('Only pick issues labelled urgent.');
  expect(f.runner.sessions[1]!.prompt).not.toContain('Only pick issues labelled ready.');
  const facts = await f.journal.readStream(artifactContextStream('review'));
  const edits = facts.filter(
    (fact) => fact.event.eventType === ArtifactContextEventType.InstructionsEdited,
  );
  expect(edits).toHaveLength(2);
  expect(edits[0]!.event.actor).toEqual({ kind: EventActorKind.Operator, id: 'web' });
});

it('persists operator edits with filesystem hosts and rejects conflicting saves across hosts', async () => {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), 'wake-operator-hosts-'));
  homes.push(home);
  const first = await createCompositionRoot(home, { config: f.config });
  const second = await createCompositionRoot(home, { config: f.config });
  const operator = { ...context(), actor: { kind: EventActorKind.Operator, id: 'web' } };
  const input = {
    contextScope: 'review',
    content: 'Only ready issues',
    revisionId: 'initial',
    expectedRevisionId: null,
  };
  await first.operatorInstructions.save(input, operator);
  const saved = await second.operatorInstructions.current('review');
  expect(saved).toMatchObject({ content: 'Only ready issues', revisionId: 'initial' });
  const results = await Promise.allSettled([
    first.operatorInstructions.save(
      { ...input, revisionId: 'first-host', expectedRevisionId: 'initial', content: 'First host' },
      { ...operator, commandId: 'first-host' },
    ),
    second.operatorInstructions.save(
      {
        ...input,
        revisionId: 'second-host',
        expectedRevisionId: 'initial',
        content: 'Second host',
      },
      { ...operator, commandId: 'second-host' },
    ),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const current = await first.operatorInstructions.current('review');
  const restarted = await createCompositionRoot(home, { config: f.config });
  expect(await restarted.operatorInstructions.current('review')).toEqual(current);
  expect(await restarted.operatorInstructions.read('review', 'initial')).toMatchObject({
    content: 'Only ready issues',
  });
});

it('does not introduce instructions when reprovisioning a run that started with an absent document', async () => {
  const f = await fixture();
  const first = await start(f);
  await execute(f.root, first);
  const run = (await f.root.execution.list(first.pendingActivation!.activationId))[0]!;
  expect(run.operatorInstructions).toEqual({ contextScope: 'review', revisionId: null });
  await f.root.operatorInstructions.save(
    {
      contextScope: 'review',
      revisionId: 'later',
      expectedRevisionId: null,
      content: 'New criteria after run start',
    },
    { ...context(), actor: { kind: EventActorKind.Operator, id: 'web' } },
  );
  const { createArtifactMcpProvisioner } = await import('../../../src/bootstrap/artifact-mcp.js');
  const { FileArtifactMcpSessionStore } = await import('../../../src/artifacts/index.js');
  const provision = createArtifactMcpProvisioner({
    artifacts: f.root.artifacts,
    orchestration: f.root.orchestration,
    journal: f.root.journal,
    operatorInstructions: f.root.operatorInstructions,
    sessions: new FileArtifactMcpSessionStore(f.root.paths.artifactsRoot),
    wakeRoot: f.root.paths.wakeRoot,
    now: () => new Date().toISOString(),
    nextId: () => 'unused',
    sharedContext: async () => ({ contextScope: 'review' }),
  });
  const capability = await provision({
    runId: run.runId,
    activation: first.pendingActivation!,
    context: {
      workItemId: first.workItemId,
      workflowInstanceId: first.workflowInstanceId,
      orchestrationGroupId: first.orchestrationGroupId,
      resources: [],
    },
  });
  try {
    expect(capability.prompt).not.toContain('New criteria after run start');
    expect(capability.operatorInstructions).toEqual({ contextScope: 'review', revisionId: null });
  } finally {
    await capability.release();
  }
});

it('accepts instructions above the general HTTP body cap only on the protected operator route', async () => {
  const f = await fixture();
  const { createApiDispatcher, createSurfaceHttpServer } =
    await import('../../../src/surfaces/index.js');
  const applications = await createSurfaceApplications(f.root);
  const server = createSurfaceHttpServer({
    dispatcher: createApiDispatcher(applications.api),
    credentials: {
      accessKey: 'test',
      sessionPassword: Buffer.alloc(32, 4).toString('base64url'),
      createdAt: new Date().toISOString(),
    },
    operatorInstructionsMaxWriteBytes: f.root.config.artifacts.maxWriteBytes,
  });
  try {
    const payload = {
      content: 'x'.repeat(70 * 1024),
      expectedRevisionId: null,
      idempotencyKey: 'large-save',
    };
    const url = '/api/v1/triggers/shared/commands/instructions';
    expect((await server.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { accessKey: 'test' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    if (typeof setCookie !== 'string') throw new Error('Expected operator cookie');
    const cookie = setCookie.split(';', 1)[0]!;
    const saved = await server.inject({ method: 'POST', url, payload, headers: { cookie } });
    expect(saved.statusCode).toBe(200);
    expect((await f.root.operatorInstructions.current('review'))?.content).toBe(payload.content);
    const ordinary = await server.inject({
      method: 'POST',
      url: '/api/v1/triggers/shared/commands/pause',
      payload,
      headers: { cookie },
    });
    expect(ordinary.statusCode).toBe(413);
  } finally {
    await server.close();
  }
});

it('lazily creates one membership-independent document, surfaces renamed scopes as orphaned and reconnects them', async () => {
  const f = await fixture();
  const applications = await createSurfaceApplications(f.root);
  expect((await applications.api.triggers!.detail('shared'))!.data.operatorInstructions).toBeNull();
  expect(await f.root.operatorInstructions.list(f.root.projections)).toEqual([]);
  expect(
    await applications.api.triggers!.saveInstructions!('shared', {
      idempotencyKey: 'create-lazy',
      content: '# Shared criteria',
      expectedRevisionId: null,
    }),
  ).toMatchObject({ status: 'completed' });
  expect((await contexts(f.root).get('review')).members).toEqual([]);
  const sharedConfig = {
    ...f.config,
    controlPlane: {
      ...f.config.controlPlane,
      triggers: f.config.controlPlane.triggers.map((trigger) => ({
        ...trigger,
        contextScope: 'review',
      })),
    },
  };
  const withSharedScope = await createCompositionRoot(f.root.paths.wakeRoot, {
    config: sharedConfig,
    journal: f.journal,
  });
  const sharedApi = (await createSurfaceApplications(withSharedScope)).api;
  expect((await sharedApi.triggers!.detail('unrelated'))!.data.operatorInstructions).toEqual(
    (await sharedApi.triggers!.detail('shared'))!.data.operatorInstructions,
  );
  expect((await sharedApi.triggers!.list()).orphanedInstructions).toEqual([]);
  const renamedConfig = {
    ...sharedConfig,
    controlPlane: {
      ...sharedConfig.controlPlane,
      triggers: sharedConfig.controlPlane.triggers.map((trigger) => ({
        ...trigger,
        contextScope: 'renamed',
      })),
    },
  };
  const renamed = await createCompositionRoot(f.root.paths.wakeRoot, {
    config: renamedConfig,
    journal: f.journal,
  });
  const renamedApi = (await createSurfaceApplications(renamed)).api;
  expect((await renamedApi.triggers!.detail('shared'))!.data.operatorInstructions).toBeNull();
  expect((await renamedApi.triggers!.list()).orphanedInstructions).toMatchObject([
    { contextScope: 'review', content: '# Shared criteria' },
  ]);
  const removed = await createCompositionRoot(f.root.paths.wakeRoot, {
    config: { ...sharedConfig, controlPlane: { ...sharedConfig.controlPlane, triggers: [] } },
    journal: f.journal,
  });
  expect(
    (await (await createSurfaceApplications(removed)).api.triggers!.list()).orphanedInstructions,
  ).toMatchObject([{ contextScope: 'review', content: '# Shared criteria' }]);
  const restored = await f.restart();
  expect(
    (await (await createSurfaceApplications(restored)).api.triggers!.detail('shared'))!.data
      .operatorInstructions,
  ).toMatchObject({ content: '# Shared criteria' });
});

// Bulk file-backed writes need headroom for fsync contention in the full suite.
it('rebuilds latest instructions metadata and polls orphan projections without replaying journal history', async () => {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), 'wake-instructions-projection-'));
  homes.push(home);
  const root = await createCompositionRoot(home, { config: f.config });
  const operator = { ...context(), actor: { kind: EventActorKind.Operator, id: 'web' } };
  const active = await root.operatorInstructions.save(
    {
      contextScope: 'review',
      revisionId: 'active',
      expectedRevisionId: null,
      content: 'Active criteria',
    },
    operator,
  );
  await root.operatorInstructions.save(
    {
      contextScope: 'retired',
      revisionId: 'first',
      expectedRevisionId: null,
      content: 'Old criteria',
    },
    operator,
  );
  const orphan = await root.operatorInstructions.save(
    {
      contextScope: 'retired',
      revisionId: 'latest',
      expectedRevisionId: 'first',
      content: 'Current orphan criteria',
    },
    operator,
  );
  for (let index = 0; index < 105; index++)
    await root.work.create(
      {
        workItemId: workId(`projection-backlog-${index}`),
        objective: 'Unrelated journal history',
      },
      { ...context(), commandId: `backlog-${index}` },
    );
  const applications = await createSurfaceApplications(root);
  expect(await root.projections.list(operatorInstructionsProjection.name)).toEqual([]);
  const initial = (await applications.api.triggers!.list()).orphanedInstructions;
  expect(initial).toMatchObject([
    { contextScope: 'retired', revisionId: 'latest', content: 'Current orphan criteria' },
  ]);
  const projected = await root.projections.read(operatorInstructionsProjection.name, 'retired');
  expect(projected?.value).toMatchObject({ revisionId: 'latest', author: 'web' });
  expect(projected?.value).not.toHaveProperty('content');
  await root.projectionSubscriptions.rebuild(operatorInstructionsProjection);
  expect((await applications.api.triggers!.list()).orphanedInstructions).toEqual(initial);
  const checkpoint = await root.journal.latestGlobalPosition();
  const tailReads = vi.spyOn(root.journal, 'readAll');
  const fullScans = vi.spyOn(root.journal, 'scanAll');
  for (let index = 0; index < 3; index++)
    expect((await applications.api.triggers!.list()).orphanedInstructions).toEqual(initial);
  expect(fullScans).not.toHaveBeenCalled();
  expect(tailReads.mock.calls.every(([after]) => after >= checkpoint)).toBe(true);
  await rm(join(root.paths.artifactsRoot, active.location));
  expect((await applications.api.triggers!.list()).orphanedInstructions).toEqual(initial);
  await rm(join(root.paths.artifactsRoot, orphan.location));
  expect((await applications.api.triggers!.list()).orphanedInstructions).toMatchObject([
    { contextScope: 'retired', revisionId: 'latest', content: null },
  ]);
  await root.operatorInstructions.save(
    {
      contextScope: 'retired',
      revisionId: 'next',
      expectedRevisionId: 'latest',
      content: 'Recovered criteria',
    },
    operator,
  );
  expect((await applications.api.triggers!.list()).orphanedInstructions).toMatchObject([
    { contextScope: 'retired', revisionId: 'next', content: 'Recovered criteria' },
  ]);
  expect(fullScans).not.toHaveBeenCalled();
}, 20_000);

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityRegistry,
  BuiltInActivityName,
  activationId,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import {
  ExecutionEventType,
  runId,
  runStream,
  TranscriptStore,
} from '../../../src/execution/index.js';
import { GitHubAdapter } from '../../../src/integrations/github/contracts/vocabulary.js';
import {
  issueCommentObservation,
  issueObservation,
} from '../../../src/integrations/github/infrastructure/issue-source.js';
import { DeliveryIntentEventType } from '../../../src/integrations/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../../../src/kernel/index.js';
import {
  EventActorKind,
  EventSourceKind,
  causationId,
  correlationId,
  createEventDraft,
  eventId,
} from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import {
  ResourceCorrelationRole,
  resourceCapability,
  resourceKind,
} from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('target composition root', () => {
  it('recovers durable started Runs through the live advance composition', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const id = runId('run-restart-recovery');
    await journal.append(runStream(id), 0, [
      createEventDraft({
        eventId: 'run-restart-recovery:started',
        eventType: ExecutionEventType.RunStarted,
        occurredAt: clock.now().toISOString(),
        correlationId: 'run-restart-recovery',
        causationId: 'run-restart-recovery',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: runStream(id),
        payload: {
          activationId: activationId('activation-restart-recovery'),
          activity: BuiltInActivityName.Agent,
          workflowInstanceId: activityWorkflowInstanceId('workflow-restart-recovery'),
          orchestrationGroupId: activityOrchestrationGroupId('group-restart-recovery'),
          attempt: 1,
          startedAt: clock.now().toISOString(),
        },
      }),
    ]);
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });

    await runtime.runnerPipeline.run({ maxProgress: 1 });

    await expect(runtime.execution.list()).resolves.toMatchObject([
      {
        runId: id,
        status: 'failed',
        failure: { message: 'External execution was never reported' },
      },
    ]);
  });

  it('routes composed journal writes through an optional integration decorator', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const writes: string[] = [];
    const decoratedJournal: EventJournal = {
      async append(stream, expectedSequence, events) {
        writes.push(`${stream.kind}:${stream.id}`);
        return journal.append(stream, expectedSequence, events);
      },
      readStream: journal.readStream.bind(journal),
      readAll: journal.readAll.bind(journal),
      readLatest: journal.readLatest?.bind(journal),
    };
    const decorator = vi.fn((base: EventJournal) => {
      expect(base).toBe(journal);
      return decoratedJournal;
    });
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateJournal: decorator,
    });

    await runtime.work.create(
      { workItemId: workId('decorated-journal'), objective: 'prove integration decoration' },
      {
        commandId: 'decorated-journal',
        correlationId: correlationId('decorated-journal'),
        occurredAt: clock.now().toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );

    expect(decorator).toHaveBeenCalledExactlyOnceWith(journal);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^work-item:/);
  });

  it('routes projection writes through the decorated projection port', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const projections = new InMemoryProjectionStore();
    let writes = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections,
      checkpoints: new InMemoryCheckpointStore(),
      decorateProjections: (base): ProjectionStore => ({
        read: base.read.bind(base),
        async write(projection) {
          writes += 1;
          await base.write(projection);
        },
        list: base.list.bind(base),
        clear: base.clear.bind(base),
      }),
    });

    await runtime.work.create(
      { workItemId: workId('decorated-projections'), objective: 'prove projection decoration' },
      commandContext(clock, 'decorated-projections'),
    );
    await runtime.projectionRunner.runRegisteredOnce();

    expect(writes).toBeGreaterThan(0);
  });

  it('routes projection checkpoints through the decorated checkpoint port', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const checkpoints = new InMemoryCheckpointStore();
    let saves = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints,
      decorateCheckpoints: (base): CheckpointStore => ({
        load: base.load.bind(base),
        async save(consumer, position) {
          saves += 1;
          await base.save(consumer, position);
        },
        reset: base.reset.bind(base),
      }),
    });

    await runtime.work.create(
      { workItemId: workId('decorated-checkpoints'), objective: 'prove checkpoint decoration' },
      commandContext(clock, 'decorated-checkpoints'),
    );
    await runtime.projectionRunner.runRegisteredOnce();

    expect(saves).toBeGreaterThan(0);
  });

  it('routes schedule slots through the supplied schedule checkpoint store', async () => {
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const saves: string[] = [];
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: scheduledRootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      scheduleCheckpoints: {
        async load() {
          return '2026-08-10T00:00:00.000Z';
        },
        async save(_scheduleId, slot) {
          saves.push(slot);
        },
      },
      clock,
    });

    await runtime.runnerPipeline.run({ maxProgress: 1 }, new AbortController().signal);

    expect(saves).toEqual(['2026-08-10T00:01:00.000Z']);
  });

  it('pauses the composed runner pipeline for maintenance and resumes it after a healthy update clears the lease', async () => {
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const saves: string[] = [];
    const root = await fixtureRoot();
    const runtime = await createCompositionRoot(root, {
      config: scheduledRootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      scheduleCheckpoints: {
        async load() {
          return '2026-08-10T00:00:00.000Z';
        },
        async save(_scheduleId, slot) {
          saves.push(slot);
        },
      },
      clock,
    });

    await runtime.maintenance.acquire('v2');
    await expect(runtime.runnerPipeline.run({ maxProgress: 1 })).resolves.toEqual({
      kind: 'paused',
    });
    expect(saves).toEqual([]);

    await runtime.maintenance.clear();
    await runtime.runnerPipeline.run({ maxProgress: 1 });
    expect(saves).toEqual(['2026-08-10T00:01:00.000Z']);
  });

  it('does not poll or translate provider intake during maintenance, then resumes intake after the lease clears', async () => {
    const root = await fixtureRoot();
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const runtime = await createCompositionRoot(root, {
      config: parseRootConfig({
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
        integrations: {
          fake: {
            enabled: true,
            provider: 'fake',
            events: [
              {
                key: 'maintenance-intake',
                title: 'must wait for update completion',
                eligible: false,
              },
            ],
          },
        },
        surfaces: {},
      }),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });

    await runtime.maintenance.acquire('v2');
    await expect(runtime.intakePipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
    expect(await runtime.journal.readAll(0)).toEqual([]);

    await runtime.maintenance.clear();
    await expect(runtime.intakePipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: true,
    });
    expect(await runtime.journal.readAll(0)).not.toEqual([]);
  });

  it('routes composed delivery through the decorated provider adapter', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    let deliveries = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: fakeProviderRootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateDeliveryAdapter: (adapter) => ({
        async deliver(intent, signal) {
          deliveries += 1;
          return adapter.deliver(intent, signal);
        },
        reconcile: adapter.reconcile.bind(adapter),
      }),
    });
    const resource = await runtime.resources.discover(
      {
        resourceId: resId('decorated-delivery'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'delivery-1' },
        capabilities: [],
      },
      commandContext(clock, 'decorated-delivery'),
    );
    await journal.append({ kind: 'resource', id: resource.resourceId }, 1, [
      {
        eventId: eventId('decorated-delivery-intent'),
        eventType: DeliveryIntentEventType.StatusPublishRequested,
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId('decorated-delivery'),
        causationId: causationId('decorated-delivery'),
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'resource', id: resource.resourceId },
        payload: {
          workflowInstanceId: 'workflow-decorated-delivery',
          activationId: 'activation-decorated-delivery',
          resourceId: resource.resourceId,
          body: 'decorated delivery',
        },
      },
    ]);
    await runtime.projectionRunner.runRegisteredOnce();

    await runtime.delivery.deliverNext(new AbortController().signal);

    expect(deliveries).toBe(1);
  });

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

  it('only creates transcript artifacts for agent executions when capture is enabled', async () => {
    const disabledRoot = await fixtureRoot();
    const disabled = await createTranscriptRuntime(disabledRoot, false);

    await executeComposedAgent(disabled.runtime);

    await expect(readdir(disabled.runtime.paths.transcriptsRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const enabledRoot = await fixtureRoot();
    const enabled = await createTranscriptRuntime(enabledRoot, true);

    await executeComposedAgent(enabled.runtime);

    const workItemDirectory = join(enabled.runtime.paths.transcriptsRoot, transcriptWorkItemId);
    const [group] = await readdir(workItemDirectory);
    if (group === undefined) throw new Error('Expected a captured transcript group');
    const artifacts = await readdir(join(workItemDirectory, group));
    const promptFile = artifacts.find((file) => file.endsWith('.prompt.txt'));
    const responseFile = artifacts.find((file) => file.endsWith('.response.txt'));
    if (promptFile === undefined || responseFile === undefined)
      throw new Error('Expected prompt and response transcript artifacts');

    expect(await readFile(join(workItemDirectory, group, promptFile), 'utf8')).toBe(
      enabled.requests[0]?.prompt,
    );
    expect(await readFile(join(workItemDirectory, group, responseFile), 'utf8')).toContain(
      '"DONE"',
    );
  });

  it('marks transcripts after reclaiming a closed then deleted workspace without writing journal events', async () => {
    const root = await fixtureRoot();
    let now = new Date('2026-08-12T10:00:00.000Z');
    const clock = { now: () => now };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    expect(runtime.config.transcripts.retentionMs).toBe(86_400_000);
    const closed = workId('transcript-retention-closed');
    const open = workId('transcript-retention-open');
    await runtime.work.create({ workItemId: closed, objective: 'close me' }, commandContext(clock, 'create-closed'));
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-work'));
    await runtime.work.delete(closed, commandContext(clock, 'delete-closed'));
    await runtime.work.create({ workItemId: open, objective: 'retain me' }, commandContext(clock, 'create-open'));
    const transcripts = new TranscriptStore(runtime.paths.transcriptsRoot);
    await transcripts.capturePrompt({ workItemId: closed, runId: 'run-closed', cli: 'fake', timestamp: clock.now().toISOString(), text: 'closed' });
    await transcripts.capturePrompt({ workItemId: open, runId: 'run-open', cli: 'fake', timestamp: clock.now().toISOString(), text: 'open' });
    const closedWorkspace = await ownedWorkspace(runtime.paths.workspacesRoot, 'closed-workspace', closed, 'closed-run');
    const openWorkspace = await ownedWorkspace(runtime.paths.workspacesRoot, 'open-workspace', open, 'open-run');
    const eventsBefore = await journal.readAll(0);

    await runtime.runnerPipeline.run({ maxProgress: 1 });

    await expect(access(closedWorkspace.path)).rejects.toThrow();
    await expect(access(openWorkspace.path)).resolves.toBeUndefined();
    await expect(readFile(join(runtime.paths.transcriptsRoot, closed, '.cleaned-at'), 'utf8')).resolves.toBe(clock.now().toISOString());
    await expect(access(join(runtime.paths.transcriptsRoot, open, '.cleaned-at'))).rejects.toThrow();
    expect(await journal.readAll(0)).toEqual(eventsBefore);

    now = new Date('2026-08-13T10:00:00.000Z');
    await runtime.runnerPipeline.run({ maxProgress: 1 });
    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
  });

  it('removes transcripts immediately when a closed then deleted workspace uses zero retention', async () => {
    const root = await fixtureRoot();
    const clock = { now: () => new Date('2026-08-12T10:00:00.000Z') };
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(0),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    const closed = workId('transcript-retention-zero');
    await runtime.work.create({ workItemId: closed, objective: 'close me' }, commandContext(clock, 'create-zero'));
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-zero'));
    await runtime.work.delete(closed, commandContext(clock, 'delete-zero'));
    const transcripts = new TranscriptStore(runtime.paths.transcriptsRoot);
    await transcripts.capturePrompt({ workItemId: closed, runId: 'run-zero', cli: 'fake', timestamp: clock.now().toISOString(), text: 'remove now' });
    await ownedWorkspace(runtime.paths.workspacesRoot, 'zero-workspace', closed, 'zero-run');

    await runtime.runnerPipeline.run({ maxProgress: 1 });

    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
  });

  it('supplies GitHub issue and comment history only through the untrusted agent context', async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'prompts', 'implement.md'),
      '---\n---\nTrusted instructions only.\nTitle: {{issueTitle}}\nBody: {{issueBody}}\n{{#each comments}}Comment: {{body}}{{/each}}',
    );
    const clock = { now: () => new Date('2026-08-08T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });
    const context = {
      commandId: 'bootstrap-comment-context',
      correlationId: correlationId('bootstrap-comment-context'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    const item = await runtime.work.create(
      { workItemId: workId('bootstrap-comment-context'), objective: 'use reviewer feedback' },
      context,
    );
    const resource = await runtime.resources.discover(
      {
        resourceId: 'resource-00000000000000000000000000' as never,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
        capabilities: [resourceCapability('commentable')],
      },
      context,
    );
    await runtime.resources.correlate(
      resource.resourceId,
      item.workItemId,
      ResourceCorrelationRole.Primary,
      context,
    );
    const issue = issueObservation({
      repository: 'atolis-hq/wake',
      issue: {
        number: 7,
        title: 'Ship comment context',
        body: 'Keep user-provided text untrusted.',
        state: 'open',
        updated_at: clock.now().toISOString(),
        user: { login: 'author', type: 'User' },
      },
    });
    await journal.append(issue.stream, 0, [issue]);
    const comment = issueCommentObservation({
      repository: 'atolis-hq/wake',
      issue: { number: 7 },
      comment: {
        id: 1,
        body: 'please add coverage',
        created_at: clock.now().toISOString(),
        updated_at: clock.now().toISOString(),
        user: { login: 'reviewer', type: 'User' },
      },
    });
    if (comment === null) throw new Error('Test comment observation was unexpectedly empty');
    await journal.append(comment.stream, 1, [comment]);
    let prompt = '';

    await runtime.activities.execute(
      {
        activationId: activationId('bootstrap-agent'),
        activity: BuiltInActivityName.Agent,
        workItemId: item.workItemId,
        workflowInstanceId: activityWorkflowInstanceId('workflow-bootstrap-agent'),
        orchestrationGroupId: activityOrchestrationGroupId('group-bootstrap-agent'),
        causationId: 'bootstrap-comment-context',
        input: { template: 'implement' },
        resources: [],
      },
      {
        signal: new AbortController().signal,
        occurredAt: clock.now().toISOString(),
        runner: {
          async start(request) {
            prompt = request.prompt;
            return { result: Promise.resolve({ transport: 'succeeded' as const, output: 'DONE' }) };
          },
        },
        async reportExternalExecution() {},
      },
    );

    expect(prompt).toMatch(
      /^Trusted instructions only\.\nTitle: Ship comment context\nBody: Keep user-provided text untrusted\.\nComment: please add coverage\n\n<wake-untrusted-data>/,
    );
    expect(prompt).toContain('"title": "Ship comment context"');
    expect(prompt).toContain('"body": "Keep user-provided text untrusted."');
    expect(prompt).toContain('"body": "please add coverage"');
  });
});

function rootConfig() {
  return parseRootConfig({
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
}

async function createTranscriptRuntime(root: string, enabled: boolean) {
  const requests: Array<{ readonly prompt: string }> = [];
  const runtime = await createCompositionRoot(root, {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      transcripts: { enabled },
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    journal: new InMemoryEventJournal({ now: () => new Date('2026-08-12T10:00:00.000Z') }),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    decorateRunner(runner) {
      return {
        async start(request, signal) {
          requests.push(request);
          return runner.start(request, signal);
        },
      };
    },
  });
  return { runtime, requests };
}

async function executeComposedAgent(runtime: Awaited<ReturnType<typeof createCompositionRoot>>) {
  const activation = activationId(`transcript-${Math.random().toString(36).slice(2)}`);
  await runtime.execution.attempt(
    {
      activationId: activation,
      ordinal: 1,
      activity: BuiltInActivityName.Agent,
      input: { prompt: 'Exact composed prompt\nwith whitespace' },
      execution: undefined,
    },
    {
      workItemId: transcriptWorkItemId,
      workflowInstanceId: activityWorkflowInstanceId('workflow-transcript-capture'),
      orchestrationGroupId: activityOrchestrationGroupId('group-transcript-capture'),
      resources: [],
    },
  );
  await vi.waitFor(async () => {
    expect((await runtime.execution.list(activation))[0]?.status).toBe('succeeded');
  });
}

const transcriptWorkItemId = workId('transcript-capture');

function scheduledRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'scheduled',
      workflows: {
        scheduled: {
          stages: {
            start: {
              activity: 'agent',
              with: { template: 'scheduled' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {
      schedules: [
        { id: 'hourly', workflow: 'scheduled', cron: '* * * * *', objective: 'Scheduled work' },
      ],
    },
    integrations: {},
    surfaces: {},
  });
}

function fakeProviderRootConfig() {
  return parseRootConfig({
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
    integrations: { fake: { enabled: true, provider: 'fake' } },
    surfaces: {},
  });
}

function transcriptRetentionConfig(retentionMs?: number) {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    transcripts: retentionMs === undefined ? { enabled: true } : { enabled: true, retentionMs },
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
}

async function ownedWorkspace(root: string, workspaceId: string, workItemId: string, runId: string) {
  const path = join(root, workspaceId);
  const markerPath = join(root, '.wake-workspace-ownership', `${workspaceId}.json`);
  await mkdir(path, { recursive: true });
  await mkdir(join(root, '.wake-workspace-ownership'), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify({
      runId,
      workItemId,
      repositoryResourceId: 'resource-00000000000000000000000000',
      mode: 'read-only',
      workspaceId,
      path,
    }),
  );
  return { path, markerPath };
}

function commandContext(clock: { now(): Date }, commandId: string) {
  return {
    commandId,
    correlationId: correlationId(commandId),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: 'test' },
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-bootstrap-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'prompts'));
  return root;
}

import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { ActivityRegistry, agentActivityDefinition } from '../../../src/activities/index.js';
import { ArtifactContextService } from '../../../src/artifacts/index.js';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import {
  ControlEventType,
  selectControlEvent,
  TriggerSkipReason,
  TriggerSourceKind,
} from '../../../src/control-plane/index.js';
import { isActiveRunStatus, RunStatus } from '../../../src/execution/index.js';
import {
  compileWorkflow,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  type WorkflowCompileDiagnostic,
} from '../../../src/orchestration/index.js';
import { WorkEventType, workItemId } from '../../../src/work/index.js';
import { ArtifactMcpRunner } from '../../support/artifact-mcp-runner.js';

const exampleAllowedTools = YAML.parse(
  await readFile('examples/delivery-oversight/config.workflows.yaml', 'utf8'),
).workflows['delivery-oversight'].stages['triage-assign'].with.allowedTools;
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = () => ({
  commandId: 'oversight-test',
  correlationId: correlationId('oversight'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'test' },
});
let occurrence = 0;

async function fixture(holdDelivery = false) {
  let releaseDelivery!: () => void;
  let deliveryStarted!: () => void;
  const deliveryStarting = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const deliveryCompletion = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const home = await mkdtemp(join(tmpdir(), 'wake-oversight-'));
  homes.push(home);
  await mkdir(join(home, 'prompts'));
  await copyFile('prompts/triage-assign.md', join(home, 'prompts/triage-assign.md'));
  const example = YAML.parse(
    await readFile('examples/delivery-oversight/config.workflows.yaml', 'utf8'),
  );
  const runner = new ArtifactMcpRunner();
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  const config = parseRootConfig({
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'delivery',
      workflows: {
        ...example.workflows,
        delivery: {
          stages: {
            implement: {
              activity: 'agent',
              with: { prompt: 'Implement delivery' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    integrations: {
      github: {
        provider: 'github',
        enabled: true,
        token: 'fake-token',
        repositories: [{ owner: 'atolis-hq', repo: 'wake' }],
        intake: [{ where: { kind: 'issue', requiredAssignees: ['wake-agent'] }, matchMode: 'all' }],
      },
    },
    controlPlane: {
      triggers: [
        {
          id: 'oversight',
          workflow: 'delivery-oversight',
          contextScope: 'delivery-main',
          on: holdDelivery ? { events: [WorkEventType.ObjectiveRevised] } : { cron: '* * * * *' },
          when: { capacityAvailable: true },
        },
      ],
    },
  });
  const restart = async () => {
    const root = await createCompositionRoot(home, {
      config,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateRunner: () => ({
        name: runner.name,
        supportsEphemeralMcp: true,
        async start(request) {
          if (holdDelivery && request.prompt.startsWith('Implement delivery')) {
            deliveryStarted();
            return {
              result: deliveryCompletion.then(() => ({
                transport: RunStatus.Succeeded,
                runner: 'fake',
                output: '[[STATUS: DONE]]',
              })),
              async cancel() {
                releaseDelivery();
              },
            };
          }
          return runner.start(request);
        },
      }),
    });
    runner.root = root;
    return root;
  };
  return {
    root: await restart(),
    restart,
    runner,
    journal,
    config,
    releaseDelivery,
    deliveryStarting,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function start(f: Fixture, root = f.root) {
  await root.triggers.start(
    f.config.controlPlane.triggers[0]!,
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
// Scripted agent decisions prove transport/composition and recovery, not live model judgment.
describe('configured delivery oversight', () => {
  it('renders plain-gh readiness and recovery guidance and carries accepted memory to a fresh invocation', async () => {
    const f = await fixture();
    const first = await start(f);
    f.runner.scripts.push({
      operations: [
        write(
          'assessment.md',
          'Skipped 1: native blocker. Skipped 2: implementation unverified despite closed issue. Selected 3; ready; focus: Finish active deliveries before starting unrelated work. Assignment observed.',
          true,
        ),
        write('memory.md', 'Revisit #2 uncertainty; #3 assigned.'),
        write('private.md', 'private local output'),
      ],
    });
    await execute(f.root, first);
    const session = f.runner.sessions[0]!;
    expect(session.allowedTools).toEqual(exampleAllowedTools);
    expect(session.allowedTools.some((tool) => tool.includes('gh api *'))).toBe(false);
    expect(session.prompt).toContain('atolis-hq/wake');
    expect(session.prompt).toContain('Finish active deliveries before starting unrelated work.');
    expect(session.prompt).toContain('dependencies/blocked_by');
    expect(session.prompt).toContain('--add-assignee @me');
    expect(session.prompt).toContain('Do not check execution');
    expect(session.prompt).toContain('memory.md is not a log');
    const root = await f.restart();
    await root.runnerPipeline.run({ maxProgress: 1 });
    const view = await new ArtifactContextService(root.journal, root.artifacts).get(
      'delivery-main',
    );
    const second = await start(f, root);
    f.runner.scripts.push({
      operations: [
        { name: 'wake_artifacts_read', arguments: { ...view.memory! } },
        write('assessment.md', 'No-op: active #3 and focus favor finishing it.'),
        write('memory.md', 'Continue #3 first.'),
      ],
    });
    await execute(root, second);
    expect(f.runner.sessions[1]!.manifest).not.toContain('private.md');
    expect(f.runner.sessions[1]!.results[0]).toMatchObject({
      content: [{ text: 'Revisit #2 uncertainty; #3 assigned.' }],
    });
    expect(
      (await root.artifacts.get(first.workItemId))!.revisions.some(
        (revision) => revision.path === 'private.md',
      ),
    ).toBe(true);
  });

  it('gates the configured oversight flow on current run capacity and starts only on a new eligible occurrence', async () => {
    const f = await fixture(true);
    const consume = () =>
      f.root.processorRuntime.catchUp(
        'oversight sources',
        f.root.processorRuntime.processors.filter((processor) =>
          processor.consumer.startsWith('reactor:control-plane.trigger:'),
        ),
      );
    const starts = async () =>
      (await f.journal.readAll(0))
        .map(selectControlEvent)
        .flatMap((event) =>
          event?.event.eventType === ControlEventType.TriggerInvocationStarted
            ? [event.event.payload]
            : [],
        );
    await consume();
    const item = workItemId('work-00000000000000000000000002');
    await f.root.work.create({ workItemId: item, objective: 'Active delivery' }, context());
    const delivery = await f.root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-capacity-delivery'),
        workItemId: item,
        workflowName: workflowName('delivery'),
        orchestrationGroupId: orchestrationGroupId('primary-capacity-delivery'),
      },
      context(),
    );
    const active = async () =>
      (await f.root.execution.list()).filter((run) => isActiveRunStatus(run.status));
    try {
      await f.root.execution.attempt(delivery.pendingActivation!, {
        workItemId: item,
        workflowInstanceId: delivery.workflowInstanceId,
        orchestrationGroupId: delivery.orchestrationGroupId,
        resources: [],
      });
      await f.deliveryStarting;
      await vi.waitFor(async () => expect(await active()).toHaveLength(1));
      await f.root.work.revise(
        { workItemId: item, objective: 'Occurrence while full' },
        { ...context(), commandId: 'capacity-full' },
      );
      await consume();
      expect(await starts()).toEqual([]);
      expect((await f.root.triggers.get()).diagnostics).toEqual([
        expect.objectContaining({
          triggerId: 'oversight',
          reason: TriggerSkipReason.Capacity,
          source: expect.objectContaining({ kind: TriggerSourceKind.Event }),
        }),
      ]);
      expect(f.runner.sessions).toHaveLength(0);
    } finally {
      f.releaseDelivery();
      await vi.waitFor(async () => expect(await active()).toHaveLength(0));
    }
    await consume();
    expect(await starts()).toEqual([]);
    await f.root.work.revise(
      { workItemId: item, objective: 'New occurrence with headroom' },
      { ...context(), commandId: 'capacity-free' },
    );
    await consume();
    const invocations = await starts();
    expect(invocations).toHaveLength(1);
    const oversight = (await f.root.orchestration.get(
      workflowInstanceId(invocations[0]!.workflowInstanceId),
    ))!;
    expect(oversight.workflowName).toBe('delivery-oversight');
    expect(oversight.workItemId).not.toBe(item);
    f.runner.scripts.push({
      operations: [
        write(
          'assessment.md',
          'No-op: capacity is available, but focus favors finishing active delivery.',
        ),
        write('memory.md', 'Finish active delivery before new assignment.'),
      ],
    });
    const completed = await execute(f.root, oversight);
    expect(completed.lastOutcome?.kind).toBe('done');
    expect(f.runner.sessions).toHaveLength(1);
  });

  it('validates the shipped trigger/integration example with its ordinary workflow', async () => {
    const configuration = YAML.parse(
      await readFile('examples/delivery-oversight/config.yaml', 'utf8'),
    );
    const workflows = YAML.parse(
      await readFile('examples/delivery-oversight/config.workflows.yaml', 'utf8'),
    );
    const parsed = parseRootConfig({
      ...configuration,
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { default: 'delivery-oversight', workflows: workflows.workflows },
    });
    const activities = new ActivityRegistry();
    activities.register(agentActivityDefinition);
    const diagnostics: WorkflowCompileDiagnostic[] = [];
    for (const [name, definition] of Object.entries(parsed.orchestration.workflows)) {
      compileWorkflow(
        name,
        definition,
        activities,
        Object.keys(parsed.orchestration.workflows),
        (diagnostic) => diagnostics.push(diagnostic),
      );
    }
    expect(diagnostics).toEqual([]);
    expect(parsed.controlPlane.triggers[0]!.when).toEqual({ capacityAvailable: true });
    expect(parsed.controlPlane.triggers[0]!.contextScope).toBe('delivery-main');
  });
});

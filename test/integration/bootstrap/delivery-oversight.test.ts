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
import { GitHubAdapter } from '../../../src/integrations/github/contracts/vocabulary.js';
import { issueObservation } from '../../../src/integrations/github/infrastructure/issue-source.js';
import { integrationStream } from '../../../src/integrations/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { selectWorkEvent, WorkEventType, workItemId } from '../../../src/work/index.js';
import { ArtifactMcpRunner } from '../../support/artifact-mcp-runner.js';
import { OversightGitHub } from '../../support/oversight-github.js';

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
  const github = new OversightGitHub();
  const runner = new ArtifactMcpRunner();
  runner.gh = github.gh;
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
    github,
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
const assign = (number?: number) => ({
  name: 'wake_github_assign',
  arguments: number === undefined ? {} : { candidate: { repository: 'atolis-hq/wake', number } },
});
const read = (operation: string, number?: number) => ({
  name: 'wake_github_read',
  arguments: {
    repository: 'atolis-hq/wake',
    operation,
    ...(number === undefined ? {} : { number }),
  },
});

// Scripted agent decisions prove transport/composition and recovery, not live model judgment.
describe('configured delivery oversight', () => {
  it('renders fail-closed readiness policy, reads native evidence, selects one ready issue, and carries accepted memory to a fresh invocation', async () => {
    const f = await fixture();
    f.github.evidence.set(
      'api --method GET repos/atolis-hq/wake/issues/1/dependencies/blocked_by --paginate',
      [{ number: 10, state: 'open' }],
    );
    f.github.evidence.set(
      'issue view 2 --repo atolis-hq/wake --json number,title,body,state,assignees,closedAt,closedByPullRequestsReferences,comments,url',
      { number: 2, body: 'Requires implementation #11', state: 'OPEN' },
    );
    f.github.evidence.set(
      'pr view 11 --repo atolis-hq/wake --json number,title,body,state,mergedAt,mergeCommit,baseRefName,closingIssuesReferences,url',
      { state: 'CLOSED', mergedAt: null },
    );
    f.github.evidence.set(
      'api --method GET repos/atolis-hq/wake/issues/3/dependencies/blocked_by --paginate',
      [],
    );
    const first = await start(f);
    f.runner.scripts.push({
      operations: [
        assign(),
        read('blocked-by', 1),
        read('issue', 2),
        read('pull-request', 11),
        read('blocked-by', 3),
        assign(3),
        assign(4),
        {
          name: 'wake_github_read',
          arguments: { repository: 'elsewhere/repo', operation: 'issues' },
        },
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
    expect(session.allowedTools).toEqual(['mcp__wake']);
    expect(session.prompt).toContain('atolis-hq/wake');
    expect(session.prompt).toContain('makes that candidate ineligible');
    expect(session.prompt).toContain('continue evaluating other candidates');
    expect(session.prompt).toContain('issue closure alone is');
    expect(session.results[6]).toMatchObject({ isError: true });
    expect(session.results[7]).toMatchObject({ isError: true });
    expect(f.github.edits).toBe(1);
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
    expect(f.github.edits).toBe(1);
    expect(
      (await root.artifacts.get(first.workItemId))!.revisions.some(
        (revision) => revision.path === 'private.md',
      ),
    ).toBe(true);
  });

  it('recovers a lost assignment response from provider state across sessions without selecting another target', async () => {
    const f = await fixture();
    f.github.interruptAssignment = true;
    const workflow = await start(f);
    f.runner.scripts.push({ operations: [assign(3)], outcome: 'FAILED' });
    const retry = await execute(f.root, workflow);
    expect(f.runner.sessions[0]!.results[0]).toMatchObject({ isError: true });
    expect(f.github.edits).toBe(1);
    const observation = issueObservation({
      repository: 'atolis-hq/wake',
      issue: {
        number: 3,
        title: 'Ready delivery',
        body: '',
        state: 'open',
        updated_at: new Date().toISOString(),
        assignees: [{ login: 'wake-agent' }],
      },
    });
    await f.journal.appendToStream(integrationStream(GitHubAdapter), 0, [observation]);
    const consume = async (root: CompositionRoot) =>
      root.processorRuntime.catchUp('GitHub intake', [root.providers[0]!.inbound.processor]);
    await consume(f.root);
    const created = async () =>
      (await f.journal.readAll(0))
        .map(selectWorkEvent)
        .filter((event) => event?.event.eventType === WorkEventType.ItemCreated);
    expect(await created()).toHaveLength(2); // oversight invocation plus delivery
    const root = await f.restart();
    await consume(root); // replay before the missing assessment is recovered
    expect(await created()).toHaveLength(2);
    f.runner.scripts.push({
      operations: [
        assign(),
        assign(4),
        assign(3),
        write('assessment.md', 'Recovered #3 from observed provider assignment.'),
        write('memory.md', '#3 assigned; no duplicate mutation.'),
      ],
    });
    await execute(root, retry);
    expect(f.runner.sessions[1]!.results[0]).toMatchObject({
      content: [
        { text: JSON.stringify({ selected: { repository: 'atolis-hq/wake', number: 3 } }) },
      ],
    });
    expect(f.runner.sessions[1]!.results[1]).toMatchObject({ isError: true });
    expect(f.github.edits).toBe(1);
  });
  it('records a successful no-op for a native blocker without assigning blocked work', async () => {
    const f = await fixture();
    f.github.evidence.set(
      'api --method GET repos/atolis-hq/wake/issues/1/dependencies/blocked_by --paginate',
      [{ number: 10, state: 'open' }],
    );
    const workflow = await start(f);
    f.runner.scripts.push({
      operations: [
        read('blocked-by', 1),
        write(
          'assessment.md',
          'No-op: #1 blocked by #10; required implementation is not verified. Revisit uncertainty next time.',
        ),
        write('memory.md', 'No assignment; revisit #10 merged/base evidence.'),
      ],
    });
    const completed = await execute(f.root, workflow);
    expect(completed.lastOutcome?.kind).toBe('done');
    expect(f.github.edits).toBe(0);
    expect(
      (await f.root.artifacts.get(workflow.workItemId))!.revisions.map((revision) => revision.path),
    ).toEqual(['assessment.md', 'memory.md']);
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
      expect(f.github.calls).toHaveLength(0);
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
        assign(),
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
    expect(f.github.edits).toBe(0);
  });

  it('records a no-op when the only candidate has an unverified issue-body implementation prerequisite', async () => {
    const f = await fixture();
    f.github.evidence.set(
      'api --method GET repos/atolis-hq/wake/issues/1/dependencies/blocked_by --paginate',
      [],
    );
    f.github.evidence.set(
      'issue view 1 --repo atolis-hq/wake --json number,title,body,state,assignees,closedAt,closedByPullRequestsReferences,comments,url',
      { number: 1, body: 'Requires implementation #10 on main before assignment.', state: 'OPEN' },
    );
    f.github.evidence.set(
      'issue view 10 --repo atolis-hq/wake --json number,title,body,state,assignees,closedAt,closedByPullRequestsReferences,comments,url',
      {
        number: 10,
        state: 'CLOSED',
        body: 'Implementation is tracked in PR #11.',
        closedByPullRequestsReferences: [],
      },
    );
    f.github.evidence.set(
      'pr view 11 --repo atolis-hq/wake --json number,title,body,state,mergedAt,mergeCommit,baseRefName,closingIssuesReferences,url',
      {
        number: 11,
        state: 'CLOSED',
        mergedAt: null,
        mergeCommit: null,
        baseRefName: 'main',
        closingIssuesReferences: [{ number: 10 }],
      },
    );
    const workflow = await start(f);
    f.runner.scripts.push({
      operations: [
        read('blocked-by', 1),
        read('issue', 1),
        read('issue', 10),
        read('pull-request', 11),
        write(
          'assessment.md',
          'No-op: sole candidate #1 requires implementation #10 on main. Issue closure is insufficient; merged/base availability is unverified. Candidate is ineligible; revisit uncertainty next invocation.',
        ),
        write('memory.md', 'Revisit #1 after verifying #10 implementation on main; no assignment.'),
      ],
    });
    const completed = await execute(f.root, workflow);
    expect(completed.lastOutcome?.kind).toBe('done');
    expect(f.github.edits).toBe(0);
    expect(f.runner.sessions[0]!.results[0]).toMatchObject({ content: [{ text: '[]' }] });
    expect(f.runner.sessions[0]!.results[1]).toMatchObject({
      content: [{ text: expect.stringContaining('Requires implementation #10') }],
    });
    const assessment = (await f.root.artifacts.get(workflow.workItemId))!.revisions.find(
      (revision) => revision.path === 'assessment.md',
    )!;
    expect(new TextDecoder().decode(await f.root.artifacts.read(assessment.location!))).toContain(
      'merged/base availability is unverified',
    );
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
    expect(parsed.controlPlane.triggers[0]!.when).toEqual({ capacityAvailable: true });
    expect(parsed.controlPlane.triggers[0]!.contextScope).toBe('delivery-main');
  });
});

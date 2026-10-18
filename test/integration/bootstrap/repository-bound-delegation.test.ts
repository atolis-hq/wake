import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import { isActiveRunStatus, RunStatus } from '../../../src/execution/index.js';
import type { DelegationReservation } from '../../../src/orchestration/contracts/delegation.js';
import {
  compileWorkflow,
  orchestrationGroupId,
  workflowDefinitionFingerprint,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
} from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('bound-delegation'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'fixture' },
});

async function git(path: string, ...args: string[]) {
  return (await exec('git', ['-C', path, ...args])).stdout.trim();
}

it('dispatches a pinned assignment through production composition, reviews the implementation head, and joins an open reviewed child PR (DC-11, DC-14, DC-15, DC-21, DC-30)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-bound-delegation-'));
  homes.push(home);
  const repository = join(home, 'upstream');
  await exec('git', ['init', '-b', 'main', repository]);
  await git(repository, 'config', 'user.name', 'Fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repository, 'source'), 'source');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'source');
  const source = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', '-c', 'prepared');
  await writeFile(join(repository, 'change'), 'implementation');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'implementation');
  const head = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', 'main');
  const stage = (mode: string, next: string) => ({
    activity: 'agent',
    with: { prompt: 'Do the assignment' },
    execution: { workspace: mode },
    requiresApproval: false,
    on: { done: { then: next } },
  });
  const runner = new ScriptedDelegationRunner();
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  let childId = '';
  const restart = async (): Promise<CompositionRoot> => {
    const config = parseRootConfig({
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'parent',
        workflows: {
          parent: { stages: { delegate: stage('none', 'done') } },
          child: {
            stages: {
              plan: stage('read-only', 'implement'),
              implement: stage('branch', 'review'),
              review: stage('read-only', 'done'),
            },
          },
        },
      },
      integrations: {
        fake: {
          enabled: true,
          events:
            childId === ''
              ? []
              : [
                  {
                    key: 'org/repo#1',
                    title: 'Agent-created PR',
                    kind: 'pull-request',
                    revision: head,
                    branch: childId,
                    baseBranch: 'integration',
                    baseRevision: source,
                    checks: 'passing',
                    acceptedReview: true,
                  },
                ],
        },
      },
    });
    return createCompositionRoot(home, {
      config,
      journal,
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
      decorateRunner: () => runner,
      decorateRepositoryCloneResolver: () => ({ cloneLocator: async () => repository }),
    });
  };
  let root = await restart();
  const parentWork = workId('bound-parent');
  await root.work.create(
    { workItemId: parentWork, objective: 'Delegate delivery' },
    context('parent'),
  );
  const repositoryId = resId('bound-repository');
  await root.resources.discover(
    {
      resourceId: repositoryId,
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'fake', key: 'org/repo' },
      capabilities: [],
    },
    context('repo'),
  );
  await root.resources.correlate(
    repositoryId,
    parentWork,
    ResourceCorrelationRole.Secondary,
    context('authority'),
  );
  const issue = resId('bound-issue');
  await root.resources.discover(
    {
      resourceId: issue,
      kind: BuiltInResourceKind.Issue,
      externalKey: { adapter: 'fake', key: 'org/repo#9' },
      capabilities: [],
    },
    context('issue'),
  );
  await root.resources.correlate(
    issue,
    parentWork,
    ResourceCorrelationRole.Primary,
    context('issue-owner'),
  );
  const parent = await root.orchestration.start(
    {
      workItemId: parentWork,
      workflowInstanceId: workflowInstanceId('bound-parent'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('bound-parent'),
    },
    context('start'),
  );
  const fingerprint = workflowDefinitionFingerprint(
    compileWorkflow('child', root.config.orchestration.workflows.child!, root.activities, [
      'parent',
      'child',
    ]),
  );
  let reservation!: DelegationReservation;
  runner.scripts.push(async (request) => {
    await expect(
      root.orchestration['delegatedWork'].reserve(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: parent.pendingActivation!.activationId,
          runId: request.runId,
        },
        'unbound-cohort',
        [
          {
            assignmentId: 'unbound',
            objective: 'Plan code',
            criteria: ['Plan'],
            workflowName: workflowName('child'),
            workflowFingerprint: fingerprint,
            context: [],
            outputs: [{ name: 'plan', path: 'plan.md' }],
          },
        ],
        context('unbound'),
      ),
    ).rejects.toThrow('require an explicit repository assignment');
    reservation = await root.orchestration['delegatedWork'].reserve(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: request.runId,
      },
      'bound-cohort',
      [
        {
          assignmentId: 'code',
          objective: 'Deliver code',
          criteria: ['Reviewed open PR'],
          workflowName: workflowName('child'),
          workflowFingerprint: fingerprint,
          context: [],
          outputs: [{ name: 'delivery', kind: 'change' }],
          repository: {
            resourceId: repositoryId,
            sourceRef: 'main',
            pullRequestBase: 'integration',
          },
        },
      ],
      context('reserve'),
    );
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  await vi.waitFor(async () =>
    expect((await root.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(false),
  );
  // Scheduling applies a completed asynchronous Run on its next pass.
  await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  childId = reservation.children[0]!.workItemId;
  expect(reservation.children[0]!.repository?.sourceRevision).toBe(source);
  await writeFile(join(repository, 'source'), 'moved main');
  await git(repository, 'commit', '-am', 'move main');
  root = await restart();
  const childWork = reservation.children[0]!.workItemId;
  const childWorkflow = reservation.children[0]!.workflowInstanceId;
  const dispatch = async () => {
    await root.advanceOnce({ workItemId: childWork, maxProgress: 1 });
    await vi.waitFor(async () =>
      expect((await root.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(
        false,
      ),
    );
    const run = (await root.execution.list())
      .filter((entry) => entry.workflowInstanceId === childWorkflow)
      .at(-1)!;
    const view = (await root.orchestration.get(childWorkflow))!;
    if (!view.acceptedOutcomes.includes(run.activationId))
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: childWorkflow,
          activationId: run.activationId,
          outcome: run.outcome!,
        },
        context('accept-' + run.runId),
      );
  };
  runner.scripts.push(async (request) => {
    expect(await git(request.workspacePath!, 'rev-parse', 'HEAD')).toBe(source);
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await dispatch();
  runner.scripts.push(async (request) => {
    expect(await git(request.workspacePath!, 'rev-parse', 'HEAD')).toBe(source);
    await git(request.workspacePath!, 'merge', '--ff-only', head);
    await git(request.workspacePath!, 'push', 'origin', childId);
    return {
      transport: RunStatus.Succeeded,
      runner: 'fake',
      output: JSON.stringify({
        status: 'DONE',
        reportedArtifacts: [
          {
            name: 'delivery',
            kind: 'pull-request',
            externalKey: { adapter: 'fake', key: 'org/repo#1' },
          },
        ],
      }),
    };
  });
  await dispatch();
  await root.processorRuntime.catchUp('register-output');
  const pr = await root.resources.findByExternalKey({ adapter: 'fake', key: 'org/repo#1' });
  expect(pr).not.toBeNull();
  await root.intakePipeline.run(new AbortController().signal);
  await root.processorRuntime.catchUp('observe-review');
  root = await restart();
  runner.scripts.push(async (request) => {
    expect(await git(request.workspacePath!, 'rev-parse', 'HEAD')).toBe(head);
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await dispatch();
  await root.orchestration.reconcileChildCompletions(context('join'));
  const results = await root.orchestration.joinedDelegationResults(
    parent.workflowInstanceId,
    'bound-cohort',
  );
  expect(results).toMatchObject([
    {
      childWorkItemId: childWork,
      outputs: [
        {
          name: 'delivery',
          reference: {
            repositoryResourceId: repositoryId,
            revision: head,
            branch: childId,
            pullRequestBase: 'integration',
          },
        },
      ],
    },
  ]);
  expect((await root.orchestration.get(childWorkflow))?.status).toBe('completed');
  expect((await root.pullRequests.get(pr!.resourceId))?.state).toBe('open');
  expect(await root.resources.primaryCorrelation(pr!.resourceId)).toMatchObject({
    workItemId: childWork,
    provenance: ResourceCorrelationProvenance.AgentReported,
  });
  expect((await root.work.get(parentWork))?.state).toBe('open');
  expect(await root.resources.primaryCorrelation(issue)).toMatchObject({ workItemId: parentWork });
});

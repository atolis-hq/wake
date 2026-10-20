import { correlationId } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ActivityEventType,
  ParentActionKind,
  selectActivityEvent,
} from '../../../src/activities/index.js';
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

it('publishes two child-owned PRs with independent provenance, exact review heads and replay isolation (DC-17, DC-29, DC-33)', async () => {
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
  await git(repository, 'switch', '-c', 'prepared-two');
  await writeFile(join(repository, 'second'), 'independent implementation');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'second implementation');
  const headTwo = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', 'main');
  const branches: Record<string, string> = {};
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
    await writeFile(
      join(home, 'provider.json'),
      JSON.stringify(
        childId === ''
          ? []
          : [
              {
                key: 'org/repo#1',
                title: 'Agent-created PR',
                kind: 'pull-request',
                revision: head,
                branch: branches.api ?? childId,
                baseBranch: 'integration',
                baseRevision: source,
                checks: 'passing',
                acceptedReview: true,
              },
              {
                key: 'org/repo#2',
                title: 'Second PR',
                kind: 'pull-request',
                revision: headTwo,
                branch: branches.web ?? childId,
                baseBranch: 'release',
                baseRevision: source,
                checks: 'passing',
                acceptedReview: true,
              },
            ],
      ),
    );
    const config = parseRootConfig({
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'parent',
        workflows: {
          parent: {
            delegation: {
              workflows: ['child'],
              maxDepth: 1,
              maxDescendants: 8,
              maxConcurrentRuns: 2,
              qa: { stage: 'qa' },
              completion: 'merge-required',
            },
            stages: {
              delegate: stage('none', 'qa'),
              qa: stage('read-only', 'merge'),
              merge: {
                activity: 'pr.merge',
                with: {
                  target: 'primary',
                  method: 'squash',
                  requireChecks: true,
                  scope: { delivery: 'next', output: { outputName: 'web' } },
                },
                requiresApproval: false,
                on: {
                  done: { then: 'done' },
                  integrated: { then: 'done' },
                  blocked: { then: 'done' },
                  failed: { then: 'done' },
                },
              },
            },
          },
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
          eventsFile: join(home, 'provider.json'),
          events: JSON.parse(await readFile(join(home, 'provider.json'), 'utf8')),
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
          outputs: [
            { name: 'api', kind: 'change' },
            {
              name: 'web',
              kind: 'change',
              repository: {
                resourceId: repositoryId,
                sourceRef: headTwo,
                sourceRevision: headTwo,
                pullRequestBase: 'release',
              },
            },
          ],
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
    const line = request.prompt.match(/Named change output workspaces[^\n]*\n([^\n]+)/)?.[1];
    expect(line).toBeDefined();
    const workspaces = JSON.parse(line!) as { name: string; path: string; branch: string }[];
    expect(new Set(workspaces.map((entry) => entry.path)).size).toBe(2);
    for (const workspace of workspaces) {
      expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(
        workspace.name === 'api' ? source : headTwo,
      );
      branches[workspace.name] = workspace.branch;
      await git(workspace.path, 'merge', '--ff-only', workspace.name === 'api' ? head : headTwo);
      await git(workspace.path, 'push', 'origin', workspace.branch);
    }
    return {
      transport: RunStatus.Succeeded,
      runner: 'fake',
      output: JSON.stringify({
        status: 'DONE',
        reportedArtifacts: [
          {
            name: 'api',
            kind: 'pull-request',
            externalKey: { adapter: 'fake', key: 'org/repo#1' },
          },
          {
            name: 'web',
            kind: 'pull-request',
            externalKey: { adapter: 'fake', key: 'org/repo#2' },
          },
        ],
      }),
    };
  });
  await dispatch();
  await writeFile(
    join(home, 'provider.json'),
    JSON.stringify([
      {
        key: 'org/repo#1',
        title: 'API',
        kind: 'pull-request',
        revision: head,
        branch: branches.api,
        baseBranch: 'integration',
        baseRevision: source,
        checks: 'passing',
        acceptedReview: true,
      },
      {
        key: 'org/repo#2',
        title: 'Web',
        kind: 'pull-request',
        revision: headTwo,
        branch: branches.web,
        baseBranch: 'release',
        baseRevision: source,
        checks: 'passing',
        acceptedReview: true,
      },
    ]),
  );
  await root.processorRuntime.catchUp('register-output');
  const pr = await root.resources.findByExternalKey({ adapter: 'fake', key: 'org/repo#1' });
  expect(pr).not.toBeNull();
  await root.intakePipeline.run(new AbortController().signal);
  await root.processorRuntime.catchUp('observe-review');
  root = await restart();
  await dispatch();
  const reviewRun = (await root.execution.list())
    .filter((run) => run.workflowInstanceId === childWorkflow && run.stage === 'review')
    .at(-1)!;
  expect(
    reviewRun.workspace?.changeOutputs?.map((output) => [output.name, output.revision]),
  ).toEqual([
    ['api', head],
    ['web', headTwo],
  ]);
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
          name: 'api',
          reference: {
            repositoryResourceId: repositoryId,
            revision: head,
            branch: branches.api,
            pullRequestBase: 'integration',
          },
        },
        {
          name: 'web',
          reference: {
            repositoryResourceId: repositoryId,
            revision: headTwo,
            branch: branches.web,
            pullRequestBase: 'release',
          },
        },
      ],
    },
  ]);
  const second = await root.resources.findByExternalKey({ adapter: 'fake', key: 'org/repo#2' });
  expect(second).not.toBeNull();
  expect(await root.resources.primaryCorrelation(second!.resourceId)).toMatchObject({
    workItemId: childWork,
    provenance: ResourceCorrelationProvenance.AgentReported,
  });
  const snapshots = (await root.execution.list()).find(
    (run) => run.changeOutputs !== undefined,
  )!.changeOutputs!;
  expect(snapshots.map((entry) => entry.revision)).toEqual([head, headTwo]);
  root = await restart();
  expect(
    await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'bound-cohort'),
  ).toEqual(results);
  expect((await root.orchestration.get(childWorkflow))?.status).toBe('completed');
  expect((await root.pullRequests.get(pr!.resourceId))?.state).toBe('open');
  expect(await root.resources.primaryCorrelation(pr!.resourceId)).toMatchObject({
    workItemId: childWork,
    provenance: ResourceCorrelationProvenance.AgentReported,
  });
  expect((await root.work.get(parentWork))?.state).toBe('open');
  expect(await root.resources.primaryCorrelation(issue)).toMatchObject({ workItemId: parentWork });
  await git(repository, 'switch', '-c', 'assembled', source);
  await git(repository, 'merge', '--ff-only', head);
  await git(repository, 'merge', '--no-edit', headTwo);
  const combined = await git(repository, 'rev-parse', 'HEAD');
  const retained = 'refs/wake/delivery/' + parentWork + '/multi/combined';
  await git(repository, 'update-ref', retained, combined);
  const dispatchParent = async () => {
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await vi.waitFor(async () =>
      expect((await root.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(
        false,
      ),
    );
    const run = (await root.execution.list())
      .filter((run) => run.workflowInstanceId === parent.workflowInstanceId)
      .at(-1)!;
    expect(run.outcome, JSON.stringify(run.failure)).toBeDefined();
    const view = (await root.orchestration.get(parent.workflowInstanceId))!;
    if (!view.acceptedOutcomes.includes(run.activationId))
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: run.activationId,
          outcome: run.outcome!,
        },
        context('accept-parent-' + run.runId),
      );
  };
  const callerFor = async (runId: string) => ({
    workflowInstanceId: parent.workflowInstanceId,
    activationId: (await root.orchestration.get(parent.workflowInstanceId))!.pendingActivation!
      .activationId,
    runId,
  });
  const contributions = ['api', 'web'].map((outputName) => ({
    childWorkItemId: childWork,
    outputName,
  }));
  runner.scripts.push(async (request) => {
    const caller = await callerFor(request.runId);
    await root.orchestration.selectDelivery(
      caller,
      {
        requestId: 'multi-selection',
        expectedRevision: 0,
        entries: contributions.map((output) => ({
          cohortId: 'bound-cohort',
          assignmentId: 'code',
          output,
        })),
      },
      context('select-multi'),
    );
    await root.orchestration.recordDeliveryCandidate(
      caller,
      {
        candidateId: 'multi',
        selectionRevision: 1,
        repositories: [
          {
            resourceId: repositoryId,
            source: { kind: 'retained-ref', ref: retained, revision: combined, contributions },
          },
        ],
      },
      context('candidate-multi'),
    );
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await dispatchParent();
  root = await restart();
  runner.scripts.push(async (request) => {
    const caller = await callerFor(request.runId);
    expect(await git(request.workspacePath!, 'rev-parse', 'HEAD')).toBe(combined);
    await root.orchestration.recordDeliveryQa(
      caller,
      {
        qaId: 'multi-qa',
        candidateId: 'multi',
        verdict: 'pass',
        revisions: [{ resourceId: repositoryId, revision: combined }],
        environment: { available: true },
        findings: [],
      },
      context('qa-multi'),
    );
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await dispatchParent();
  const mergeActivation = (await root.orchestration.get(parent.workflowInstanceId))!
    .pendingActivation!;
  expect(mergeActivation.activity).toBe('pr.merge');
  const action = {
    workflowInstanceId: parent.workflowInstanceId,
    activationId: mergeActivation.activationId,
    action: ParentActionKind.Merge,
  };
  expect(await root.orchestration.authorizeParentAction(action)).toEqual({
    kind: 'denied',
    reason: 'ambiguous-resource',
  });
  expect(
    await root.orchestration.authorizeParentAction({ ...action, output: { outputName: 'web' } }),
  ).toMatchObject({
    kind: 'target',
    resourceId: second!.resourceId,
    revision: headTwo,
    context: {
      ownerWorkItemId: childWork,
      requestingWorkItemId: parentWork,
      output: { childWorkItemId: childWork, outputName: 'web' },
    },
  });
  await root.work.grantAutoApproval(childWork, context('child-consent'));
  await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  const mergeRequests = (await journal.readAll(0))
    .map(selectActivityEvent)
    .filter((event) => event?.event.eventType === ActivityEventType.PrMergeRequested);
  expect(mergeRequests).toHaveLength(1);
  expect(mergeRequests[0]!.event.payload).toMatchObject({
    resourceId: second!.resourceId,
    revision: headTwo,
    parent: { ownerWorkItemId: childWork, requestingWorkItemId: parentWork },
  });
  root = await restart();
  await root.processorRuntime.catchUp('replay-named-merge');
  expect(
    (await journal.readAll(0))
      .map(selectActivityEvent)
      .filter((event) => event?.event.eventType === ActivityEventType.PrMergeRequested),
  ).toHaveLength(1);
  expect((await root.orchestration.get(childWorkflow))?.status).toBe('completed');
  for (const resource of [pr!, second!])
    expect(await root.resources.primaryCorrelation(resource.resourceId)).toMatchObject({
      workItemId: childWork,
    });
});

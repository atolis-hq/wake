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
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('multi-repository'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'fixture' },
});

async function git(path: string, ...args: string[]) {
  return (await exec('git', ['-C', path, ...args])).stdout.trim();
}

async function initRepository(path: string, label: string) {
  await exec('git', ['init', '-b', 'main', path]);
  await git(path, 'config', 'user.name', 'Fixture');
  await git(path, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(path, 'source'), label);
  await git(path, 'add', '.');
  await git(path, 'commit', '-m', label);
  const source = await git(path, 'rev-parse', 'HEAD');
  const commit = async (name: string, base = source) => {
    await git(path, 'switch', '-c', name, base);
    await writeFile(join(path, name), name);
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', name);
    const sha = await git(path, 'rev-parse', 'HEAD');
    await git(path, 'switch', 'main');
    return sha;
  };
  return { source, commit };
}

type Child = DelegationReservation['children'][number];

it('binds children to different repositories, rejects a foreign source, and verifies each PR in its own repository (DC-11, DC-14, DC-15)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-two-repositories-'));
  homes.push(home);
  const paths = { a: join(home, 'repo-a'), b: join(home, 'repo-b') };
  const repoA = await initRepository(paths.a, 'a');
  const repoB = await initRepository(paths.b, 'b');
  const headA1 = await repoA.commit('a-one');
  const headB1 = await repoB.commit('b-one');
  const repositoryIds = { a: resId('two-repo-a'), b: resId('two-repo-b') };
  const clones = new Map<string, string>([
    [repositoryIds.a, paths.a],
    [repositoryIds.b, paths.b],
  ]);
  const stage = (mode: string, next: string) => ({
    activity: 'agent',
    with: { prompt: 'Do the assignment' },
    execution: { workspace: mode },
    requiresApproval: false,
    on: { done: { then: next } },
  });
  const runner = new ScriptedDelegationRunner();
  const journal = new InMemoryEventJournal({ now: () => new Date() });
  let children: readonly Child[] = [];
  const restart = async (): Promise<CompositionRoot> =>
    createCompositionRoot(home, {
      config: parseRootConfig({
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
                implement: stage('branch', 'check'),
                check: stage('read-only', 'verify'),
                verify: stage('read-only', 'done'),
              },
            },
          },
        },
        integrations: {
          fake: {
            enabled: true,
            events: children.map((child, index) => ({
              key: index === 0 ? 'org/a#1' : 'org/b#1',
              title: 'Agent-created PR',
              kind: 'pull-request',
              revision: index === 0 ? headA1 : headB1,
              branch: child.workItemId,
              baseBranch: index === 0 ? 'integration-a' : 'integration-b',
              checks: 'passing',
              acceptedReview: true,
            })),
          },
        },
      }),
      journal,
      checkpoints: new InMemoryCheckpointStore(),
      projections: new InMemoryProjectionStore(),
      decorateRunner: () => runner,
      decorateRepositoryCloneResolver: () => ({
        cloneLocator: async (id: string) => clones.get(id)!,
      }),
    });
  let current = await restart();
  const parentWork = workId('two-repo-parent');
  await current.work.create({ workItemId: parentWork, objective: 'Two repos' }, context('parent'));
  for (const [name, key] of [
    ['a', 'org/a'],
    ['b', 'org/b'],
  ] as const) {
    await current.resources.discover(
      {
        resourceId: repositoryIds[name],
        kind: BuiltInResourceKind.Repository,
        externalKey: { adapter: 'fake', key },
        capabilities: [],
      },
      context('repo-' + name),
    );
    await current.resources.correlate(
      repositoryIds[name],
      parentWork,
      ResourceCorrelationRole.Secondary,
      context('authority-' + name),
    );
  }
  const parent = await current.orchestration.start(
    {
      workItemId: parentWork,
      workflowInstanceId: workflowInstanceId('two-repo-parent'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('two-repo-parent'),
    },
    context('start'),
  );
  const fingerprint = workflowDefinitionFingerprint(
    compileWorkflow('child', current.config.orchestration.workflows.child!, current.activities, [
      'parent',
      'child',
    ]),
  );
  const assignment = (id: string, repo: 'a' | 'b', base: string, sourceRevision?: string) => ({
    assignmentId: id,
    objective: 'Deliver ' + id,
    criteria: ['Open PR'],
    workflowName: workflowName('child'),
    workflowFingerprint: fingerprint,
    context: [],
    outputs: [
      { name: 'delivery', kind: 'change' as const, requireReview: false, requireChecks: false },
    ],
    repository: {
      resourceId: repositoryIds[repo],
      sourceRef: 'main',
      pullRequestBase: base,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
    },
  });
  let reservation!: DelegationReservation;
  runner.scripts.push(async (request) => {
    const delegation = {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: parent.pendingActivation!.activationId,
      runId: request.runId,
    };
    // A commit that exists only in repository A is not a valid source in repository B.
    await expect(
      current.orchestration['delegatedWork'].reserve(
        delegation,
        'foreign',
        [assignment('foreign', 'b', 'integration-b', repoA.source)],
        context('foreign'),
      ),
    ).rejects.toThrow(/is unavailable/);
    reservation = await current.orchestration['delegatedWork'].reserve(
      delegation,
      'two-repos',
      [assignment('a', 'a', 'integration-a'), assignment('b', 'b', 'integration-b')],
      context('reserve'),
    );
    return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
  });
  await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  await vi.waitFor(async () =>
    expect((await current.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(
      false,
    ),
  );
  await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  children = reservation.children;
  expect(children.map((child) => child.repository?.sourceRevision)).toEqual([
    repoA.source,
    repoB.source,
  ]);
  current = await restart();
  const dispatch = async (child: Child) => {
    await current.processorRuntime.catchUp('register-output');
    await current.advanceOnce({ workItemId: child.workItemId, maxProgress: 1 });
    await vi.waitFor(async () =>
      expect((await current.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(
        false,
      ),
    );
    const run = (await current.execution.list())
      .filter((entry) => entry.workflowInstanceId === child.workflowInstanceId)
      .at(-1)!;
    // Register reported PRs before a later stage can complete the child.
    await current.processorRuntime.catchUp('register-output');
    const view = (await current.orchestration.get(child.workflowInstanceId))!;
    if (!view.acceptedOutcomes.includes(run.activationId))
      await current.orchestration.acceptOutcome(
        {
          workflowInstanceId: child.workflowInstanceId,
          activationId: run.activationId,
          outcome: run.outcome!,
        },
        context('accept-' + run.runId),
      );
  };
  const [childA, childB] = children as [Child, Child];
  // The agent works from the workspace Wake prepared: each starts at its own repository's
  // pinned source, publishes a change there, and reports the PR it opened.
  const act = async (request: { workspacePath?: string | undefined }) => {
    const workspace = request.workspacePath!;
    // Read-only stages have no branch to publish.
    if ((await git(workspace, 'branch', '--show-current')) === '')
      return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
    const inA = (await git(workspace, 'remote', 'get-url', 'origin')) === paths.a;
    expect(await git(workspace, 'rev-parse', 'HEAD')).toBe(inA ? repoA.source : repoB.source);
    const head = inA ? headA1 : headB1;
    await git(workspace, 'fetch', 'origin', head);
    await git(workspace, 'merge', '--ff-only', head);
    await git(workspace, 'push', 'origin', 'HEAD:refs/heads/' + (inA ? childA : childB).workItemId);
    return {
      transport: RunStatus.Succeeded,
      runner: 'fake',
      output: JSON.stringify({
        status: 'DONE',
        reportedArtifacts: [
          {
            name: 'delivery',
            kind: 'pull-request',
            externalKey: { adapter: 'fake', key: inA ? 'org/a#1' : 'org/b#1' },
          },
        ],
      }),
    };
  };
  runner.scripts.push(act, act, act, act);
  for (let round = 0; round < 3; round++) {
    // Provider observations follow registration; observing earlier would admit the PR as new work.
    if (round > 0) {
      await current.processorRuntime.catchUp('register-output');
      await current.intakePipeline.run(new AbortController().signal);
      await current.processorRuntime.catchUp('observe-review');
    }
    await dispatch(childA);
    await dispatch(childB);
  }
  await current.orchestration.reconcileChildCompletions(context('join'));

  const results = await current.orchestration.joinedDelegationResults(
    parent.workflowInstanceId,
    'two-repos',
  );
  expect(results).toHaveLength(2);
  const byChild = new Map(results.map((entry) => [entry.childWorkItemId, entry.outputs[0]!]));
  expect(byChild.get(childA.workItemId)?.reference).toMatchObject({
    repositoryResourceId: repositoryIds.a,
    revision: headA1,
    pullRequestBase: 'integration-a',
  });
  expect(byChild.get(childB.workItemId)?.reference).toMatchObject({
    repositoryResourceId: repositoryIds.b,
    revision: headB1,
    pullRequestBase: 'integration-b',
  });
  expect((await current.work.get(parentWork))?.state).toBe('open');
}, 60_000);

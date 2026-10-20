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
import { isActiveRunStatus, RunStatus, type RunnerRequest } from '../../../src/execution/index.js';
import type { DelegationReservation } from '../../../src/orchestration/contracts/delegation.js';
import {
  compileWorkflow,
  DeliveryRejectionError,
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
  correlationId: correlationId('delivery-qa'),
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
  const commit = async (name: string) => {
    await git(path, 'switch', '-c', name, source);
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

const done = { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
// Enough read-only stages that no child completes before its PR has been observed.
const checks = Array.from({ length: 8 }, (_, index) => `check-${index}`);

it('assembles independent changes into a retained fetchable candidate and QA reconstructs it after the assembly workspace is deleted (DC-16, DC-34)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-delivery-qa-'));
  homes.push(home);
  const paths = { a: join(home, 'repo-a'), b: join(home, 'repo-b') };
  const repoA = await initRepository(paths.a, 'a');
  const repoB = await initRepository(paths.b, 'b');
  const headA1 = await repoA.commit('a-one');
  const headA2 = await repoA.commit('a-two');
  const headB1 = await repoB.commit('b-one');
  const repositoryIds = { a: resId('qa-repo-a'), b: resId('qa-repo-b') };
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
  const pulls = [
    { key: 'org/a#1', head: headA1, base: 'integration-a' },
    { key: 'org/a#2', head: headA2, base: 'integration-a' },
    { key: 'org/b#1', head: headB1, base: 'integration-b' },
  ];
  const createRoot = (): Promise<CompositionRoot> =>
    createCompositionRoot(home, {
      config: parseRootConfig({
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: {
          default: 'observed',
          workflows: {
            // Provider observations of work Wake did not delegate run this inert workflow.
            observed: {
              stages: {
                watch: {
                  ...stage('none', 'done'),
                  with: { prompt: 'Observe only' },
                },
              },
            },
            parent: {
              stages: {
                // The delegating stage resumes after the join to assess and QA the combined work.
                delegate: { ...stage('none', 'done'), with: { prompt: 'PARENT-STAGE' } },
              },
            },
            child: {
              stages: {
                implement: stage('branch', checks[0]!),
                ...Object.fromEntries(
                  checks.map((name, index) => [
                    name,
                    stage('read-only', checks[index + 1] ?? 'done'),
                  ]),
                ),
              },
            },
          },
        },
        integrations: {
          fake: {
            enabled: true,
            events: children.map((child, index) => ({
              key: pulls[index]!.key,
              title: 'Agent-created PR',
              kind: 'pull-request',
              revision: pulls[index]!.head,
              branch: child.workItemId,
              baseBranch: pulls[index]!.base,
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
  let current = await createRoot();
  const parentWork = workId('qa-parent');
  await current.work.create({ workItemId: parentWork, objective: 'Parent QA' }, context('parent'));
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
      workflowInstanceId: workflowInstanceId('qa-parent'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('qa-parent'),
    },
    context('start'),
  );
  const fingerprint = workflowDefinitionFingerprint(
    compileWorkflow('child', current.config.orchestration.workflows.child!, current.activities, [
      'parent',
      'child',
    ]),
  );
  const assignment = (id: string, repo: 'a' | 'b', base: string) => ({
    assignmentId: id,
    objective: 'Deliver ' + id,
    criteria: ['The two repositories work together'],
    workflowName: workflowName('child'),
    workflowFingerprint: fingerprint,
    context: [],
    outputs: [
      { name: 'delivery', kind: 'change' as const, requireReview: false, requireChecks: false },
    ],
    repository: { resourceId: repositoryIds[repo], sourceRef: 'main', pullRequestBase: base },
  });
  let reservation!: DelegationReservation;
  runner.scripts.push(async (request) => {
    reservation = await current.orchestration['delegatedWork'].reserve(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: request.runId,
      },
      'cohort',
      [
        assignment('a1', 'a', 'integration-a'),
        assignment('a2', 'a', 'integration-a'),
        assignment('b1', 'b', 'integration-b'),
      ],
      context('reserve'),
    );
    return done;
  });
  const settle = async () =>
    vi.waitFor(async () =>
      expect((await current.execution.list()).some((run) => isActiveRunStatus(run.status))).toBe(
        false,
      ),
    );
  await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  await settle();
  await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  children = reservation.children;
  current = await createRoot();

  const dispatch = async (child: Child) => {
    await current.processorRuntime.catchUp('register-output');
    await current.advanceOnce({ workItemId: child.workItemId, maxProgress: 1 });
    await settle();
    await current.processorRuntime.catchUp('register-output');
    const run = (await current.execution.list())
      .filter((entry) => entry.workflowInstanceId === child.workflowInstanceId)
      .at(-1);
    if (run === undefined) return;
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
  // The agent works from the workspace Wake prepared and reports the PR it opened.
  const act = async (request: { workspacePath?: string | undefined }) => {
    const workspace = request.workspacePath!;
    const branch = await git(workspace, 'branch', '--show-current');
    if (branch === '') return done;
    const index = children.findIndex((child) => branch.includes(child.workItemId));
    if (index < 0) throw new Error(`Unexpected workspace branch ${branch}`);
    const pull = pulls[index]!;
    await git(workspace, 'fetch', 'origin', pull.head);
    await git(workspace, 'merge', '--ff-only', pull.head);
    await git(workspace, 'push', 'origin', 'HEAD:refs/heads/' + children[index]!.workItemId);
    return {
      ...done,
      output: JSON.stringify({
        status: 'DONE',
        reportedArtifacts: [
          {
            name: 'delivery',
            kind: 'pull-request',
            externalKey: { adapter: 'fake', key: pull.key },
          },
        ],
      }),
    };
  };
  // The resumed parent activation is the agent QA stage; every delivery action is Run-bound.
  const [a1, a2, b1] = children as [Child, Child, Child];
  const refName = `refs/wake/delivery/${String(parentWork)}/asm-1/repo-a`;
  const assembly = join(home, 'assembly');
  let assembled = '';
  const keys = (items: readonly Child[]) =>
    items.map((child) => ({ childWorkItemId: child.workItemId, outputName: 'delivery' }));
  const rejected: string[] = [];
  const expectRejected = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DeliveryRejectionError);
    rejected.push((error as DeliveryRejectionError).code);
    expect((error as DeliveryRejectionError).code).toBe(code);
  };
  const callerFor = async (request: RunnerRequest) => ({
    workflowInstanceId: parent.workflowInstanceId,
    activationId: (await current.orchestration.get(parent.workflowInstanceId))!.pendingActivation!
      .activationId,
    runId: request.runId,
  });
  const assemble = async (request: RunnerRequest) => {
    const caller = await callerFor(request);
    await current.orchestration.selectDelivery(
      caller,
      {
        requestId: 'select-1',
        expectedRevision: 0,
        entries: children.map((child) => ({
          cohortId: 'cohort',
          assignmentId: child.assignmentId,
          output: { childWorkItemId: child.workItemId, outputName: 'delivery' },
        })),
      },
      context('select'),
    );
    // Independent changes in one repository need an assembled commit, not one of their heads.
    await expectRejected(
      current.orchestration.recordDeliveryCandidate(
        caller,
        {
          candidateId: 'asm-1',
          selectionRevision: 1,
          repositories: [
            { resourceId: repositoryIds.a, source: { kind: 'output', tip: keys([a1])[0]! } },
            { resourceId: repositoryIds.b, source: { kind: 'output', tip: keys([b1])[0]! } },
          ],
        },
        context('unassembled'),
      ),
      'candidate-coverage',
    );
    // The agent assembles in its own workspace and publishes only a retained ref.
    await exec('git', ['clone', paths.a, assembly]);
    await git(assembly, 'config', 'user.name', 'Assembler');
    await git(assembly, 'config', 'user.email', 'assembler@example.test');
    await git(assembly, 'fetch', 'origin', headA1, headA2);
    await git(assembly, 'checkout', '--detach', headA1);
    await git(assembly, 'merge', '--no-edit', headA2);
    assembled = await git(assembly, 'rev-parse', 'HEAD');
    const candidate = {
      candidateId: 'asm-1',
      selectionRevision: 1,
      repositories: [
        {
          resourceId: repositoryIds.a,
          source: {
            kind: 'retained-ref' as const,
            ref: refName,
            revision: assembled,
            contributions: keys([a1, a2]),
          },
        },
        { resourceId: repositoryIds.b, source: { kind: 'output' as const, tip: keys([b1])[0]! } },
      ],
    };
    // A local commit that was never pushed is not a durable source.
    await expectRejected(
      current.orchestration.recordDeliveryCandidate(caller, candidate, context('local-only')),
      'source-unavailable',
    );
    await git(assembly, 'push', 'origin', `HEAD:${refName}`);
    await current.orchestration.recordDeliveryCandidate(caller, candidate, context('candidate'));
  };
  const qaCommand = (qaId: string, overrides: object = {}) => ({
    qaId,
    candidateId: 'asm-1',
    verdict: 'pass' as const,
    revisions: [
      { resourceId: repositoryIds.a, revision: assembled },
      { resourceId: repositoryIds.b, revision: headB1 },
    ],
    environment: { available: true },
    findings: [],
    ...overrides,
  });
  const reconstructed = join(home, 'reconstructed');
  const verify = async (request: RunnerRequest, restarted: CompositionRoot) => {
    const caller = await callerFor(request);
    await exec('git', ['clone', '--no-checkout', paths.a, reconstructed]);
    await git(reconstructed, 'fetch', 'origin', refName);
    await git(reconstructed, 'checkout', '--detach', 'FETCH_HEAD');
    expect(await git(reconstructed, 'rev-parse', 'HEAD')).toBe(assembled);
    const files = await git(reconstructed, 'ls-files');
    expect(files).toContain('a-one');
    expect(files).toContain('a-two');

    // QA of main, or of only one repository, cannot satisfy the gate.
    await expectRejected(
      restarted.orchestration.recordDeliveryQa(
        caller,
        qaCommand('qa-main', {
          revisions: [
            { resourceId: repositoryIds.a, revision: repoA.source },
            { resourceId: repositoryIds.b, revision: headB1 },
          ],
        }),
        context('qa-main'),
      ),
      'revision-mismatch',
    );
    // A moved retained ref can no longer pass; neither can a missing one.
    await git(paths.a, 'update-ref', refName, headA1);
    await expectRejected(
      restarted.orchestration.recordDeliveryQa(caller, qaCommand('qa-moved'), context('qa-moved')),
      'source-unavailable',
    );
    await git(paths.a, 'update-ref', '-d', refName);
    await expectRejected(
      restarted.orchestration.recordDeliveryQa(caller, qaCommand('qa-gone'), context('qa-gone')),
      'source-unavailable',
    );
    await git(paths.a, 'update-ref', refName, assembled);
    await restarted.orchestration.recordDeliveryQa(
      caller,
      qaCommand('qa-pass'),
      context('qa-pass'),
    );
  };
  let scriptError: unknown;
  const qaStage = async (request: RunnerRequest) => {
    try {
      await runQaStage(request);
    } catch (error) {
      // A failed script would only fail the Run; keep the cause for the test to assert on.
      scriptError = error;
      throw error;
    }
    return done;
  };
  const runQaStage = async (request: RunnerRequest) => {
    await assemble(request);
    expect(assembled).toMatch(/^[a-f0-9]{40}$/);
    // Delete the assembly workspace and restart: the candidate is rebuilt from the retained ref.
    await rm(assembly, { recursive: true, force: true });
    await verify(request, await createRoot());
  };
  runner.scriptFor = (request) =>
    request.prompt.includes('PARENT-STAGE')
      ? qaStage
      : request.prompt.includes('Do the assignment')
        ? act
        : undefined;

  const completed = async () =>
    (
      await Promise.all(
        children.map((child) => current.orchestration.get(child.workflowInstanceId)),
      )
    ).every((view) => view?.status === 'completed');
  for (let round = 0; round < checks.length + 3 && !(await completed()); round++) {
    if (round > 0) {
      await current.processorRuntime.catchUp('register-output');
      // The provider reveals one observation per pass; every PR must be observed first.
      for (let pass = 0; pass < pulls.length; pass++) {
        await current.intakePipeline.run(new AbortController().signal);
        await current.processorRuntime.catchUp('observe-review');
      }
    }
    for (const child of children) await dispatch(child);
  }
  await current.orchestration.reconcileChildCompletions(context('join'));
  // The join resumes the parent into its QA stage, which runs under a real Run.
  await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
  await settle();
  expect(scriptError).toBeUndefined();
  expect(rejected).toEqual([
    'candidate-coverage',
    'source-unavailable',
    'revision-mismatch',
    'source-unavailable',
    'source-unavailable',
  ]);

  // The durable facts survive restart and show only the accepted selection, candidate and pass.
  const facts = (await journal.readAll(0)).filter((entry) =>
    entry.event.eventType.startsWith('orchestration.delivery-'),
  );
  expect(facts.map((entry) => entry.event.eventType)).toEqual([
    'orchestration.delivery-selection-revised',
    'orchestration.delivery-candidate-recorded',
    'orchestration.delivery-qa-recorded',
  ]);
}, 120_000);

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
import { ActivityEventType, PullRequestState } from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import { presentDelivery } from '../../../src/bootstrap/surface-api-delivery.js';
import {
  isActiveRunStatus,
  runId,
  RunRepository,
  RunStatus,
  type RunnerRequest,
} from '../../../src/execution/index.js';
import { DeliveryIntentKind, DeliveryResultKind } from '../../../src/integrations/index.js';
import type { DelegationReservation } from '../../../src/orchestration/contracts/delegation.js';
import {
  compileWorkflow,
  DeliveryRejectionError,
  orchestrationGroupId,
  workflowDefinitionFingerprint,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
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

const done = { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
// Enough read-only stages that no child completes before its PR has been observed.
const checks = Array.from({ length: 8 }, (_, index) => `check-${index}`);

it.each([
  'pass',
  'blocked',
  'exhausted',
  'merge-required',
  'repair',
  'recover-source',
  'recover-environment',
] as const)(
  'prepares exact multi-repo QA after restart and enforces the %s handoff (DC-16, DC-18, DC-24, DC-34)',
  async (mode) => {
    const recovery = mode.startsWith('recover-');
    let refineRuns = 0;
    const home = await mkdtemp(join(tmpdir(), 'wake-delivery-qa-'));
    homes.push(home);
    const paths = { a: join(home, 'repo-a'), b: join(home, 'repo-b') };
    const repoA = await initRepository(paths.a, 'a');
    const repoB = await initRepository(paths.b, 'b');
    const headA1 = await repoA.commit('a-one');
    const headA2 = await repoA.commit('a-two');
    const headB1 = await repoB.commit('b-one');
    const fixA1 = await repoA.commit('a-one-fix', headA1);
    const fixA2 = await repoA.commit('a-two-fix', headA2);
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
    const visiblePulls = new Set<string>();
    let sourceOutage = false;
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
                entry: recovery ? 'refine' : 'delegate',
                delegation: {
                  workflows: ['child'],
                  maxDepth: 1,
                  maxDescendants: 8,
                  maxConcurrentRuns: 4,
                  completion: ['merge-required', 'repair'].includes(mode)
                    ? 'merge-required'
                    : 'qa-approved',
                  qa: { stage: 'qa' },
                },
                stages: {
                  ...(recovery
                    ? {
                        refine: {
                          ...stage('none', 'delegate'),
                          with: { prompt: 'REFINE-STAGE' },
                          on: { done: { then: 'delegate', repeat: { max: 1 } } },
                        },
                      }
                    : {}),
                  // The delegating stage resumes after the join to assess and QA the combined work.
                  delegate: {
                    ...stage('none', 'qa'),
                    with: { prompt: 'ASSEMBLE-STAGE' },
                    on: { done: { then: 'qa', repeat: { max: 2 } } },
                  },
                  ...(mode === 'repair'
                    ? {
                        integrate: {
                          activity: 'pr.merge',
                          with: {
                            scope: { delivery: 'next' },
                            method: 'squash',
                            requireChecks: true,
                          },
                          requiresApproval: false,
                          on: {
                            done: { then: 'integrate', repeat: { max: 5 } },
                            integrated: { then: 'done' },
                          },
                        },
                      }
                    : {}),
                  qa: {
                    ...stage('read-only', 'done'),
                    with: { prompt: 'QA-STAGE' },
                    on: {
                      done: { then: mode === 'repair' ? 'integrate' : 'done' },
                      failed: { then: 'delegate', repeat: { max: 1 } },
                    },
                  },
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
                checks: visiblePulls.has(child.workItemId) ? 'passing' : 'pending',
                eligible: visiblePulls.has(child.workItemId),
                acceptedReview: true,
              })),
            },
          },
        }),
        journal,
        checkpoints: new InMemoryCheckpointStore(),
        projections: new InMemoryProjectionStore(),
        decorateRunner: () => runner,
        decorateDeliveryAdapter: (adapter) =>
          mode !== 'repair'
            ? adapter
            : {
                async deliver(intent) {
                  if (intent.payload.kind === DeliveryIntentKind.PrMerge) {
                    const pull = (await current.pullRequests.get(intent.resourceId))!;
                    await current.pullRequests.observe(
                      { ...pull, state: PullRequestState.Merged },
                      context('merged-' + intent.intentEventId),
                    );
                  }
                  return { kind: DeliveryResultKind.Confirmed, externalId: intent.intentEventId };
                },
                async reconcile() {
                  return { kind: DeliveryResultKind.NotFound };
                },
              },
        decorateRepositoryCloneResolver: () => ({
          cloneLocator: async (id: string) => {
            if (sourceOutage) throw new Error('Temporary remote transport outage');
            return clones.get(id)!;
          },
        }),
      });
    let current = await createRoot();
    const parentWork = workId('qa-parent');
    await current.work.create(
      { workItemId: parentWork, objective: 'Parent QA' },
      context('parent'),
    );
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
      ...(id === 'a2' && mode === 'repair'
        ? {
            prerequisites: [
              { assignmentId: 'a1', output: 'delivery', condition: 'delivery-ready' as const },
            ],
          }
        : {}),
      workflowName: workflowName('child'),
      workflowFingerprint: fingerprint,
      context: [],
      outputs: [
        { name: 'delivery', kind: 'change' as const, requireReview: false, requireChecks: false },
      ],
      repository: { resourceId: repositoryIds[repo], sourceRef: 'main', pullRequestBase: base },
    });
    let reservation!: DelegationReservation;
    if (recovery)
      runner.scripts.push(async () => {
        refineRuns++;
        return done;
      });
    runner.scripts.push(async (request) => {
      reservation = await current.orchestration['delegatedWork'].reserve(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: (await current.orchestration.get(parent.workflowInstanceId))!
            .pendingActivation!.activationId,
          runId: request.runId,
        },
        'cohort',
        [
          assignment('a1', 'a', 'integration-a'),
          assignment('a2', 'a', 'integration-a'),
          assignment('b1', 'b', 'integration-b'),
        ],
        context('reserve'),
        { maxDepth: 1, maxDescendants: mode === 'repair' ? 5 : 3, maxConcurrentRuns: 4 },
      );
      return done;
    });
    const settle = async (workflowId?: string) =>
      vi.waitFor(async () =>
        expect(
          (await current.execution.list()).some(
            (run) =>
              isActiveRunStatus(run.status) &&
              (workflowId === undefined || run.workflowInstanceId === workflowId),
          ),
        ).toBe(false),
      );
    const startDelegation = async () => {
      for (let pass = 0; pass < 4 && reservation === undefined; pass++) {
        await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
        await settle();
      }
      await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await settle();
    };
    await startDelegation();
    expect(reservation, JSON.stringify(await current.execution.list())).toBeDefined();
    children = reservation.children;
    current = await createRoot();

    const runRepository = new RunRepository(journal);
    const dispatch = async (child: Child) => {
      await current.processorRuntime.catchUp('register-output');
      await current.advanceOnce({ workItemId: child.workItemId, maxProgress: 1 });
      await settle(child.workflowInstanceId);
      await current.processorRuntime.catchUp('register-output');
      const latest = (await current.execution.list())
        .filter((entry) => entry.workflowInstanceId === child.workflowInstanceId)
        .at(-1);
      if (latest === undefined) return;
      const run = await vi.waitFor(
        async () => {
          const view = (await runRepository.load(runId(latest.runId))).view!;
          expect(isActiveRunStatus(view.status)).toBe(false);
          return view;
        },
        { timeout: 10_000 },
      );
      await current.processorRuntime.catchUp('settled-output');
      expect(run.status, JSON.stringify(run.failure)).toBe('succeeded');
      expect(run.outcome).toBeDefined();
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
      await expectRejected(
        current.orchestration.selectDelivery(
          caller,
          {
            requestId: 'waive',
            expectedRevision: 0,
            entries: [
              {
                cohortId: 'cohort',
                assignmentId: a1.assignmentId,
                output: { childWorkItemId: a1.workItemId, outputName: 'delivery' },
              },
            ],
          },
          context('waive'),
        ),
        'uncovered-requirement',
      );
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
      await expect(
        current.orchestration.recordDeliveryQa(
          caller,
          qaCommand('self-pass'),
          context('self-pass'),
        ),
      ).rejects.toThrow('configured QA stage');
    };
    const qaCommand = (qaId: string, overrides: object = {}) => ({
      qaId,
      candidateId: 'asm-1',
      verdict: 'pass' as const,
      revisions: [
        { resourceId: repositoryIds.a, revision: assembled },
        { resourceId: repositoryIds.b, revision: headB1.toUpperCase() },
      ],
      environment: { available: true },
      findings: [],
      ...overrides,
    });
    let qaRounds = 0;
    const verify = async (request: RunnerRequest, restarted: CompositionRoot) => {
      const caller = await callerFor(request);
      if (repaired) {
        await restarted.orchestration.recordDeliveryQa(
          caller,
          { ...qaCommand('repaired-pass'), candidateId: 'repaired' },
          context('repaired-pass'),
        );
        return;
      }
      const run = (await restarted.execution.list()).find(
        (entry) => entry.runId === request.runId,
      )!;
      const prepared = run.workspace!.candidate!;
      expect(prepared.candidateId).toBe('asm-1');
      expect(prepared.repositories).toHaveLength(2);
      const reconstructed = prepared.repositories.find(
        (entry) => entry.resourceId === repositoryIds.a,
      )!.path;
      const other = prepared.repositories.find((entry) => entry.resourceId === repositoryIds.b)!;
      expect(await git(other.path, 'rev-parse', 'HEAD')).toBe(headB1);
      expect(request.prompt).toContain('The two repositories work together');
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
        restarted.orchestration.recordDeliveryQa(
          caller,
          qaCommand('qa-moved'),
          context('qa-moved'),
        ),
        'source-unavailable',
      );
      await git(paths.a, 'update-ref', '-d', refName);
      await expectRejected(
        restarted.orchestration.recordDeliveryQa(caller, qaCommand('qa-gone'), context('qa-gone')),
        'source-unavailable',
      );
      await git(paths.a, 'update-ref', refName, assembled);
      await expect(
        restarted.orchestration.recordDeliveryQa(
          { ...caller, runId: 'not-the-run' },
          qaCommand('forged'),
          context('forged'),
        ),
      ).rejects.toThrow('stale');
      await expect(
        restarted.orchestration.selectDelivery(
          caller,
          { requestId: 'self-select', expectedRevision: 1, entries: [] },
          context('self-select'),
        ),
      ).rejects.toThrow();
      const verdict =
        mode === 'blocked' || (mode === 'recover-environment' && qaRounds === 0)
          ? 'blocked'
          : mode === 'exhausted' || mode === 'repair'
            ? 'fail'
            : 'pass';
      const final = qaCommand(`qa-final-${qaRounds++}`, {
        verdict,
        environment: { available: verdict !== 'blocked' },
        findings:
          verdict === 'pass' ? [] : ['Configured test environment or candidate needs repair'],
      });
      const accepted = await restarted.orchestration.recordDeliveryQa(
        caller,
        final,
        context('qa-final'),
      );
      expect(accepted.qa.exhausted === true).toBe(mode === 'exhausted');
      expect(
        (await restarted.orchestration.recordDeliveryQa(caller, final, context('qa-replay')))
          .replay,
      ).toBe(true);
      if (mode === 'recover-source' && qaRounds === 1) sourceOutage = true;
    };
    let repaired = false;
    let repairChildren: readonly Child[] = [];
    const observe = async () => {
      await current.processorRuntime.catchUp('register-before-observation');
      let changed = false;
      for (const run of await current.execution.list()) {
        if (run.status !== RunStatus.Succeeded || run.workspace?.mode !== 'branch') continue;
        const child = children.find((child) => child.workflowInstanceId === run.workflowInstanceId);
        if (child !== undefined && !visiblePulls.has(child.workItemId)) {
          const index = children.indexOf(child);
          const resource = await current.resources.findByExternalKey({
            adapter: 'fake',
            key: pulls[index]!.key,
          });
          if (
            resource === null ||
            (await current.resources.primaryCorrelation(resource.resourceId))?.workItemId !==
              child.workItemId
          )
            continue;
          visiblePulls.add(child.workItemId);
          changed = true;
        }
      }
      // Keep verification evidence available, but publish observations only after the agent's report.
      if (changed) current = await createRoot();
      await current.intakePipeline.run(new AbortController().signal);
    };
    const repair = async (request: RunnerRequest) => {
      const caller = await callerFor(request);
      const correction = (original: Child, id: string, repo: 'a' | 'b', revision: string) => {
        const { workflowFingerprint: _fingerprint, ...submitted } = assignment(
          id,
          repo,
          'integration-' + repo,
        );
        return {
          ...submitted,
          replaces: { cohortId: 'cohort', assignmentId: original.assignmentId },
          repository: {
            ...submitted.repository,
            sourceRef: original.workItemId,
            sourceRevision: revision,
          },
        };
      };
      if (repairChildren.length === 0) {
        const next = await current.orchestration.submitDelegation(
          caller,
          {
            cohortId: 'repairs',
            assignments: [
              correction(a1, 'fix-a', 'a', headA1),
              correction(a2, 'fix-a2', 'a', headA2),
            ],
          },
          context('repair'),
        );
        repairChildren = next.children;
        const fixes = repairChildren;
        children = [...children, ...fixes];
        pulls.push(
          { key: 'org/a#3', head: fixA1, base: 'integration-a' },
          { key: 'org/a#4', head: fixA2, base: 'integration-a' },
        );
        current = await createRoot();
        return;
      }
      const fixes = repairChildren;
      await current.orchestration.reconcileChildCompletions(context('repair-join'));
      // Replacing the lower layer stales only its previous consumer, not the independent change.
      const initialSelection = (
        await current.orchestration.deliveryStateFor(parent.workflowInstanceId)
      ).selection!;
      const replacement = {
        cohortId: 'cohort',
        assignmentId: a1.assignmentId,
        output: { childWorkItemId: fixes[0]!.workItemId, outputName: 'delivery' },
        replaces: { childWorkItemId: a1.workItemId, outputName: 'delivery' },
      };
      const unchanged = initialSelection.entries.slice(1).map((entry) => ({
        cohortId: entry.cohortId,
        assignmentId: entry.assignmentId,
        output: { childWorkItemId: entry.childWorkItemId, outputName: entry.output.name },
      }));
      await current.orchestration.selectDelivery(
        caller,
        {
          requestId: 'lower-replacement',
          expectedRevision: 1,
          entries: [replacement, ...unchanged],
        },
        context('lower-replacement'),
      );
      const stale = await current.orchestration.deliveryStateFor(parent.workflowInstanceId);
      expect(stale.stale).toContain('cohort/a2/delivery');
      expect(stale.stale).not.toContain('cohort/b1/delivery');
      const fixRun = (await current.execution.list()).find(
        (run) =>
          run.workflowInstanceId === fixes[1]!.workflowInstanceId &&
          run.workspace?.mode === 'branch',
      )!;
      const fixResource = await current.resources.findByExternalKey({
        adapter: 'fake',
        key: 'org/a#4',
      });
      expect(
        (await current.orchestration.deliveryStateFor(parent.workflowInstanceId)).required.length,
      ).toBe(3);
      expect(fixResource, JSON.stringify(fixRun)).not.toBeNull();
      expect(
        await current.resources.primaryCorrelation(fixResource!.resourceId),
        JSON.stringify(fixRun),
      ).toMatchObject({ workItemId: fixes[1]!.workItemId, provenance: 'agent-reported' });
      await current.orchestration.selectDelivery(
        caller,
        {
          requestId: 'consumer-replacement',
          expectedRevision: 2,
          entries: [
            { ...replacement, replaces: undefined },
            {
              cohortId: 'cohort',
              assignmentId: a2.assignmentId,
              output: { childWorkItemId: fixes[1]!.workItemId, outputName: 'delivery' },
              replaces: { childWorkItemId: a2.workItemId, outputName: 'delivery' },
            },
            unchanged[1]!,
          ],
        },
        context('consumer-replacement'),
      );
      await exec('git', ['clone', paths.a, assembly]);
      await git(assembly, 'config', 'user.name', 'Assembler');
      await git(assembly, 'config', 'user.email', 'assembler@example.test');
      await git(assembly, 'checkout', '--detach', fixA1);
      await git(assembly, 'merge', '--no-edit', fixA2);
      assembled = await git(assembly, 'rev-parse', 'HEAD');
      const repairedRef = refName.replace('/asm-1/', '/repaired/');
      await git(assembly, 'push', 'origin', 'HEAD:' + repairedRef);
      await current.orchestration.recordDeliveryCandidate(
        caller,
        {
          candidateId: 'repaired',
          selectionRevision: 3,
          repositories: [
            {
              resourceId: repositoryIds.a,
              source: {
                kind: 'retained-ref',
                ref: repairedRef,
                revision: assembled,
                contributions: keys(fixes),
              },
            },
            { resourceId: repositoryIds.b, source: { kind: 'output', tip: keys([b1])[0]! } },
          ],
        },
        context('repaired-candidate'),
      );
      repaired = true;
    };
    let scriptError: unknown;
    const qaStage = async (request: RunnerRequest) => {
      if (
        (await current.orchestration.get(parent.workflowInstanceId))!.delegationAttention !==
        undefined
      )
        return done;
      try {
        await runQaStage(request);
      } catch (error) {
        // A failed script would only fail the Run; keep the cause for the test to assert on.
        scriptError ??= error;
        throw error;
      }
      return done;
    };
    const runQaStage = async (request: RunnerRequest) => {
      if (mode.startsWith('recover-') && qaRounds > 0) return;
      if (
        mode === 'repair' &&
        (await current.orchestration.deliveryStateFor(parent.workflowInstanceId)).history.length > 0
      ) {
        if (!repaired) await repair(request);
        return;
      }
      await assemble(request);
      expect(assembled).toMatch(/^[a-f0-9]{40}$/);
      // Delete the assembly workspace and restart: the candidate is rebuilt from the retained ref.
      await rm(assembly, { recursive: true, force: true });
    };
    runner.scriptFor = (request) =>
      request.prompt.includes('ASSEMBLE-STAGE')
        ? qaStage
        : request.prompt.includes('QA-STAGE')
          ? async (request) => {
              await verify(request, current);
              return mode === 'repair' && !repaired
                ? { ...done, output: '{"status":"FAILED"}' }
                : done;
            }
          : request.prompt.includes('Do the assignment')
            ? act
            : undefined;

    const completed = async () =>
      (
        await Promise.all(
          children.map((child) => current.orchestration.get(child.workflowInstanceId)),
        )
      ).every((view) => view?.status === 'completed');
    for (let round = 0; round < checks.length * 3 + 6 && !(await completed()); round++) {
      if (round > 0) {
        await current.processorRuntime.catchUp('register-output');
        // The provider reveals one observation per pass; every PR must be observed first.
        for (let pass = 0; pass < pulls.length; pass++) {
          await observe();
          await current.processorRuntime.catchUp('observe-review');
        }
      }
      for (const child of children) await dispatch(child);
    }
    expect(
      await completed(),
      JSON.stringify(await current.orchestration.deliveryTree(parentWork)),
    ).toBe(true);
    await current.orchestration.reconcileChildCompletions(context('join'));
    // The join resumes the parent into its QA stage, which runs under a real Run.
    await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await settle();
    expect(scriptError).toBeUndefined();
    current = await createRoot();
    await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await settle();
    await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    const advanceRepairs = async () => {
      if (repairChildren.length === 0 || repaired) return;
      for (let round = 0; round < checks.length + 3 && !(await completed()); round++) {
        if (round > 0) {
          for (let pass = 0; pass < pulls.length; pass++) await observe();
          await current.processorRuntime.catchUp('repair-observations');
        }
        for (const child of repairChildren) await dispatch(child);
      }
      await current.orchestration.reconcileChildCompletions(context('repair-join-external'));
    };
    const driveParent = async () => {
      await advanceRepairs();
      for (
        let pass = 0;
        pass < 10 &&
        !['completed', 'blocked', 'superseded'].includes(
          (await current.orchestration.get(parent.workflowInstanceId))!.status,
        );
        pass++
      ) {
        await current.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
        await settle();
        await advanceRepairs();
        if (mode === 'repair' && repaired) {
          for (let delivered = 0; delivered < 100; delivered++) {
            await current.processorRuntime.catchUp('repair-delivery');
            if ((await current.delivery.deliverNext(new AbortController().signal)) === null) break;
          }
          await current.processorRuntime.catchUp('repair-delivery-results');
          await settle();
        }
      }
    };
    const assertHandoff = async () => {
      await driveParent();
      expect(
        (await current.orchestration.get(parent.workflowInstanceId))!.status,
        JSON.stringify(
          (await current.execution.list()).filter(
            (run) => run.workflowInstanceId === parent.workflowInstanceId,
          ),
        ),
      ).toBe(mode === 'pass' || mode === 'repair' ? 'completed' : 'blocked');
      expect(rejected).toEqual([
        'uncovered-requirement',
        'candidate-coverage',
        'source-unavailable',
        'revision-mismatch',
        'source-unavailable',
        'source-unavailable',
      ]);

      const presented = await presentDelivery(current, (await current.work.get(parentWork))!);
      expect(presented.delegation!.qa).toMatchObject({
        canComplete: mode === 'pass' || mode === 'repair',
        effective: true,
        exhausted: mode === 'exhausted',
        selectionRevision: mode === 'repair' ? 3 : 1,
        candidateId: mode === 'repair' ? 'repaired' : 'asm-1',
      });
      expect(presented.delegation!.qa!.repositories).toHaveLength(2);
    };
    await assertHandoff();
    expect(scriptError).toBeUndefined();
    if (mode.startsWith('recover-')) {
      const blocked = (await current.orchestration.get(parent.workflowInstanceId))!;
      expect(blocked.deliveryGateBlock).toEqual({ retryStage: 'delegate' });
      expect(blocked.blockReason).toContain(
        mode === 'recover-source' ? 'operational fetch/check failed' : 'QA verdict is blocked',
      );
      sourceOutage = false;
      current = await createRoot();
      await current.orchestration.retryBlockedFailedStage(
        parent.workflowInstanceId,
        context('retry-delivery-gate'),
      );
      const resumed = (await current.orchestration.get(parent.workflowInstanceId))!;
      expect(resumed.deliveryGateBlock).toBeUndefined();
      expect(resumed.currentStage).toBe('delegate');
      expect(refineRuns).toBe(1);
      expect(resumed.pendingActivation!.sessionPolicy).toBe('fresh');
      expect(resumed.repeatCounts).toEqual(blocked.repeatCounts);
      expect(resumed.retryCounts).toEqual(blocked.retryCounts);
      await current.orchestration.retryBlockedFailedStage(
        parent.workflowInstanceId,
        context('retry-delivery-gate'),
      );
      expect(
        (await current.orchestration.get(parent.workflowInstanceId))!.pendingActivation!
          .activationId,
      ).toBe(resumed.pendingActivation!.activationId);
      await driveParent();
      expect(scriptError).toBeUndefined();
      expect((await current.orchestration.get(parent.workflowInstanceId))!.status).toBe(
        'completed',
      );
      expect(qaRounds).toBe(2);
      expect(refineRuns).toBe(1);
      expect(
        (await current.orchestration.deliveryStateFor(parent.workflowInstanceId)).history,
      ).toHaveLength(2);
      return;
    }
    const assertReplacementOwners = async () => {
      const state = await current.orchestration.deliveryStateFor(parent.workflowInstanceId);
      const mergeIntents = (await journal.readAll(0)).flatMap(({ event }) =>
        event.eventType === ActivityEventType.PrMergeRequested ? [event.payload] : [],
      );
      expect(mergeIntents).toHaveLength(3);
      for (const replacement of repairChildren) {
        const selected = state.selection!.entries.find(
          (entry) => entry.childWorkItemId === replacement.workItemId,
        )!;
        if (!('resourceId' in selected.output.reference))
          throw new Error('Expected a replacement PR');
        const target = resourceId(selected.output.reference.resourceId);
        expect(await current.resources.primaryCorrelation(target)).toMatchObject({
          workItemId: replacement.workItemId,
        });
        expect(await current.pullRequests.get(target)).toMatchObject({
          state: PullRequestState.Merged,
          workItemId: replacement.workItemId,
        });
        expect(mergeIntents).toContainEqual(
          expect.objectContaining({
            resourceId: target,
            parent: expect.objectContaining({
              ownerWorkItemId: replacement.workItemId,
              requestingWorkItemId: parentWork,
            }),
          }),
        );
        expect((await current.orchestration.get(replacement.workflowInstanceId))!.status).toBe(
          'completed',
        );
      }
    };
    if (mode === 'repair') {
      await assertReplacementOwners();
      expect(repaired).toBe(true);
      expect(
        (await current.orchestration.deliveryStateFor(parent.workflowInstanceId)).history,
      ).toHaveLength(2);
      return;
    }
    // The durable facts survive restart and show only the accepted selection, candidate and pass.
    const facts = (await journal.readAll(0)).filter((entry) =>
      entry.event.eventType.startsWith('orchestration.delivery-'),
    );
    expect(facts.map((entry) => entry.event.eventType)).toEqual([
      'orchestration.delivery-selection-revised',
      'orchestration.delivery-candidate-recorded',
      'orchestration.delivery-qa-recorded',
    ]);
  },
  120_000,
);

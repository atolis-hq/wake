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
import { expect, it, vi } from 'vitest';
import {
  ActivityEventType,
  ParentActionKind,
  PullRequestState,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createOneShotRunnerAdvance,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import { presentDelivery } from '../../../src/bootstrap/surface-api-delivery.js';
import {
  isActiveRunStatus,
  RunStatus,
  type AgentRunnerResult,
  type RunnerRequest,
} from '../../../src/execution/index.js';
import type { GitHubPullRequestPayload } from '../../../src/integrations/github/contracts/payloads.js';
import { verifiedCheckSubject } from '../../../src/integrations/github/infrastructure/pr-check-subject.js';
import {
  DeliveryIntentKind,
  DeliveryResultKind,
  type DeliveryIntentView,
  type ExternalDeliveryAdapter,
} from '../../../src/integrations/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  type DelegationReservation,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../../src/resources/index.js';
import { workItemId } from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

const exec = promisify(execFile);
const git = async (path: string, ...args: string[]) =>
  (await exec('git', ['-C', path, ...args])).stdout.trim();
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('governed-integration'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'provider-fixture' },
});

type Child = DelegationReservation['children'][number];

type RepoKey = 'a' | 'b';

const done: AgentRunnerResult = {
  transport: RunStatus.Succeeded,
  runner: 'fake',
  output: '{"status":"DONE"}',
};

/**
 * Six assignments in two repositories: 1 and 3 target the integration branch, 2 is stacked on 1
 * and 3 of repository B consumes the contract that 1 of repository A published.
 */
const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'] as const;
const repoOf = (id: string): RepoKey => id[0] as RepoKey;
const stackBase = (id: string) => (id === 'a2' ? 'a1' : id === 'b2' ? 'b1' : undefined);
const pullKey = (id: string) => `org/${id[0]}#${id[1]}`;

// One composed scenario keeps the six-child, two-repository proof in a single restartable flow.
// eslint-disable-next-line complexity
it('integrates two squash-merged stacks through scoped parent merges, agent maintenance, fresh QA and restart (DC-24, DC-30, DC-33, DC-36)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-governed-integration-'));
  try {
    const paths = { a: join(home, 'a'), b: join(home, 'b') };
    const repositories = { a: resId('gov-a'), b: resId('gov-b') };
    const heads = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const repo of ['a', 'b'] as const) {
      const path = paths[repo];
      await exec('git', ['init', '-b', 'main', path]);
      await git(path, 'config', 'user.name', 'Agent fixture');
      await git(path, 'config', 'user.email', 'agent@example.test');
      await git(path, 'config', 'receive.denyCurrentBranch', 'ignore');
      await writeFile(join(path, 'source'), repo);
      await git(path, 'add', '.');
      await git(path, 'commit', '-m', 'source');
      const commit = async (id: string, from: string) => {
        await git(path, 'switch', '-c', 'prepared-' + id, from);
        await writeFile(join(path, id), id);
        await git(path, 'add', '.');
        await git(path, 'commit', '-m', id);
        heads.set(id, await git(path, 'rev-parse', 'HEAD'));
        await git(path, 'switch', 'main');
      };
      sources.set(repo, await git(path, 'rev-parse', 'HEAD'));
      await commit(repo + '1', 'main');
      await commit(repo + '2', 'prepared-' + repo + '1');
      await commit(repo + '3', 'main');
    }

    const eventsFile = join(home, 'provider-prs.json');
    const maintained = new Map<string, string>();
    const writeProvider = () =>
      writeFile(
        eventsFile,
        JSON.stringify(
          ids.map((id) => ({
            key: pullKey(id),
            title: id,
            kind: 'pull-request',
            branch: childOf(id).workItemId,
            revision: maintained.get(id) ?? heads.get(id),
            baseBranch: maintained.has(id)
              ? 'main'
              : stackBase(id) === undefined
                ? 'main'
                : childOf(stackBase(id)!).workItemId,
          })),
        ),
      );
    const runner = new ScriptedDelegationRunner();
    const journal = new InMemoryEventJournal({ now: () => new Date() });
    const checkpoints = new InMemoryCheckpointStore();
    const projections = new InMemoryProjectionStore();
    let children: readonly Child[] = [];
    const childOf = (id: string) => children.find((child) => child.assignmentId === id)!;
    const parentWork = workId('gov-parent');
    const agentStage = (workspace: string, next: string, prompt: string) => ({
      activity: 'agent',
      with: { prompt },
      execution: { workspace },
      requiresApproval: false,
      on: { done: { then: next } },
    });
    const mergeEvents: string[] = [];
    const plannedMovementTargets: string[] = [];
    // The provider fixture: applies the requested squash to a real repository and reports the
    // merged pull request, so Wake only ever learns of a merge from provider-observed facts.
    const delivery: ExternalDeliveryAdapter = {
      async deliver(intent: DeliveryIntentView) {
        if (intent.payload.kind !== DeliveryIntentKind.PrMerge)
          return { kind: DeliveryResultKind.Confirmed, externalId: 'noop' };
        const pull = (await root.pullRequests.get(intent.resourceId))!;
        const found = await findIdFor(intent.resourceId);
        const repo = repoOf(found);
        if (pull.state !== PullRequestState.Merged) {
          await git(paths[repo], 'merge', '--squash', pull.headRevision);
          await git(paths[repo], 'commit', '-m', 'squash ' + found);
          mergeEvents.push(found);
          await root.pullRequests.observe(
            {
              ...pull,
              state: PullRequestState.Merged,
              mergeRevision: await git(paths[repo], 'rev-parse', 'HEAD'),
            },
            context('merged-' + found),
          );
          const baseRevision = await git(paths[repo], 'rev-parse', 'HEAD');
          for (const sibling of ids.filter((id) => repoOf(id) === repo && id !== found)) {
            const resource = await root.resources.findByExternalKey({
              adapter: 'fake',
              key: pullKey(sibling),
            });
            if (resource === null) continue;
            const observed = await root.pullRequests.get(resource.resourceId);
            if (
              observed?.state !== PullRequestState.Open ||
              (stackBase(sibling) !== undefined && !maintained.has(sibling))
            )
              continue;
            await root.pullRequests.observe(
              { ...observed, baseRevision, checkEvidence: undefined },
              context('base-after-' + found + '-' + sibling),
            );
            const assessment = (
              await root.orchestration.deliveryStateFor(parent.workflowInstanceId)
            ).integration!;
            expect(
              assessment.targets.find((target) => target.resourceId === resource.resourceId),
            ).toMatchObject({
              baseMovement: 'planned-progress',
              evidenceAffected: true,
            });
            plannedMovementTargets.push(sibling);
          }
        }
        return { kind: DeliveryResultKind.Confirmed, externalId: 'merge-' + found };
      },
      async reconcile() {
        return { kind: DeliveryResultKind.NotFound };
      },
    };
    const findIdFor = async (resourceId: string) => {
      for (const id of ids) {
        const resource = await root.resources.findByExternalKey({
          adapter: 'fake',
          key: pullKey(id),
        });
        if (resource?.resourceId === resourceId) return id;
      }
      throw new Error('Unknown merged resource');
    };

    const open = () =>
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
              parent: {
                delegation: {
                  workflows: ['child'],
                  maxDescendants: 8,
                  maxDepth: 1,
                  maxConcurrentRuns: 3,
                  completion: 'merge-required',
                  qa: { stage: 'qa' },
                  maintenance: { stage: 'maintain' },
                },
                stages: {
                  delegate: {
                    ...agentStage('none', 'qa', 'ASSEMBLE-STAGE'),
                    on: { done: { then: 'qa', repeat: { max: 8 } } },
                  },
                  qa: {
                    ...agentStage('read-only', 'integrate', 'QA-STAGE'),
                    on: {
                      done: { then: 'integrate', repeat: { max: 6 } },
                      failed: { then: 'delegate', repeat: { max: 1 } },
                    },
                  },
                  integrate: {
                    activity: 'pr.merge',
                    with: {
                      scope: { delivery: 'next' },
                      method: 'squash',
                      requireChecks: true,
                    },
                    requiresApproval: false,
                    on: {
                      done: { then: 'integrate', repeat: { max: 8 } },
                      integrated: { then: 'done' },
                      blocked: { then: 'maintain', repeat: { max: 4 } },
                    },
                  },
                  maintain: {
                    ...agentStage('none', 'delegate', 'MAINTAIN-STAGE'),
                    on: { done: { then: 'delegate', repeat: { max: 4 } } },
                  },
                },
              },
              child: {
                stages: {
                  implement: agentStage('branch', 'review', 'Deliver the assignment'),
                  review: agentStage('read-only', 'verify', 'Review the assignment'),
                  verify: agentStage('read-only', 'done', 'Verify the assignment'),
                },
              },
            },
          },
          integrations: {
            fake: {
              enabled: true,
              eventsFile,
              // Provider observations of the pull requests the agents open, as GitHub would show them.
              events: children.map((child) => {
                const id = child.assignmentId;
                const base = stackBase(id);
                return {
                  key: pullKey(id),
                  kind: 'pull-request',
                  title: id,
                  revision: heads.get(id)!,
                  branch: child.workItemId,
                  baseBranch: base === undefined ? 'main' : childOf(base).workItemId,
                  baseRevision: base === undefined ? sources.get(repoOf(id))! : heads.get(base)!,
                  checks: 'passing',
                  acceptedReview: true,
                };
              }),
            },
          },
        }),
        journal,
        checkpoints,
        projections,
        decorateRunner: () => runner,
        decorateDeliveryAdapter: () => delivery,
        decorateRepositoryCloneResolver: () => ({
          cloneLocator: async (id: string) => (id === repositories.a ? paths.a : paths.b),
        }),
      });
    let root: CompositionRoot = await open();
    await root.work.create({ workItemId: parentWork, objective: 'Two stacks' }, context('create'));
    for (const repo of ['a', 'b'] as const) {
      await root.resources.discover(
        {
          resourceId: repositories[repo],
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'fake', key: 'org/' + repo },
          capabilities: [],
        },
        context('repo-' + repo),
      );
      await root.resources.correlate(
        repositories[repo],
        parentWork,
        ResourceCorrelationRole.Secondary,
        context('scope-' + repo),
      );
    }
    const parent = await root.orchestration.start(
      {
        workItemId: parentWork,
        workflowInstanceId: workflowInstanceId('gov-parent'),
        workflowName: workflowName('parent'),
        orchestrationGroupId: orchestrationGroupId('gov-parent'),
      },
      context('start'),
    );
    const settle = async () =>
      vi.waitFor(async () =>
        expect((await root.execution.list()).every((run) => !isActiveRunStatus(run.status))).toBe(
          true,
        ),
      );
    const callerFor = async (request: RunnerRequest) => ({
      workflowInstanceId: parent.workflowInstanceId,
      activationId: (await root.orchestration.get(parent.workflowInstanceId))!.pendingActivation!
        .activationId,
      runId: request.runId,
    });

    // --- Parent scripts -------------------------------------------------------------------
    const assemblies = join(home, 'assemblies');
    let candidates = 0;
    let qaRounds = 0;
    const maintenanceRecords: string[] = [];
    const stages: string[] = [];
    const assignments = ids.map((id) => ({
      assignmentId: id,
      objective: 'Implement ' + id,
      criteria: ['Publish exact named outputs'],
      workflowName: workflowName('child'),
      context: [],
      repository: {
        resourceId: repositories[repoOf(id)],
        sourceRef: 'main',
        pullRequestBase: 'main',
      },
      outputs: [
        { name: 'change', kind: 'change' as const, requireReview: true, requireChecks: true },
        ...(id === 'a1' ? [{ name: 'contract', path: 'contract.md' }] : []),
      ],
      prerequisites: [
        ...(stackBase(id) === undefined
          ? []
          : [
              {
                assignmentId: stackBase(id)!,
                output: 'change',
                condition: 'pushed-change' as const,
                useAsBase: true,
              },
            ]),
        ...(id === 'b3'
          ? [{ assignmentId: 'a1', output: 'contract', condition: 'accepted-output' as const }]
          : []),
      ],
    }));
    const assemble = async (request: RunnerRequest) => {
      const caller = await callerFor(request);
      const state = await root.orchestration.deliveryStateFor(parent.workflowInstanceId);
      if (state.selection === null)
        await root.orchestration.selectDelivery(
          caller,
          {
            requestId: 'select-1',
            expectedRevision: 0,
            entries: children.flatMap((child) => [
              {
                cohortId: 'six',
                assignmentId: child.assignmentId,
                output: { childWorkItemId: child.workItemId, outputName: 'change' },
              },
              ...(child.assignmentId === 'a1'
                ? [
                    {
                      cohortId: 'six',
                      assignmentId: child.assignmentId,
                      output: { childWorkItemId: child.workItemId, outputName: 'contract' },
                    },
                  ]
                : []),
            ]),
          },
          context('select'),
        );
      const selection = (await root.orchestration.deliveryStateFor(parent.workflowInstanceId))
        .selection!;
      const candidateId = `asm-${++candidates}`;
      const repositoriesCommand = [];
      for (const repo of ['a', 'b'] as const) {
        const working = join(assemblies, `${candidateId}-${repo}`);
        await exec('git', ['clone', paths[repo], working]);
        await git(working, 'config', 'user.name', 'Assembler');
        await git(working, 'config', 'user.email', 'assembler@example.test');
        await git(working, 'checkout', '--detach', 'origin/main');
        const entries = selection.entries.filter(
          (entry) =>
            childOf(repo + '1').workItemId === entry.childWorkItemId ||
            childOf(repo + '2').workItemId === entry.childWorkItemId ||
            childOf(repo + '3').workItemId === entry.childWorkItemId,
        );
        for (const entry of entries) {
          const reference = entry.output.reference as { revision?: string };
          if (reference.revision === undefined) continue;
          await git(working, 'fetch', 'origin', reference.revision);
          await git(working, 'merge', '--no-edit', reference.revision);
        }
        // The first assembled candidate deliberately misses integration configuration. After
        // QA identifies it, the assembling agent repairs that candidate rather than child work.
        if (candidates > 1) {
          await writeFile(join(working, 'integration-ready'), 'ready');
          await git(working, 'add', 'integration-ready');
          await git(working, 'commit', '-m', 'Repair integration configuration');
        }
        const assembled = await git(working, 'rev-parse', 'HEAD');
        const ref = `refs/wake/delivery/${String(parentWork)}/${candidateId}/repo-${repo}`;
        await git(working, 'push', 'origin', `HEAD:${ref}`);
        repositoriesCommand.push({
          resourceId: repositories[repo],
          source: {
            kind: 'retained-ref' as const,
            ref,
            revision: assembled,
            contributions: entries
              .filter((entry) => entry.output.name === 'change')
              .map((entry) => ({ childWorkItemId: entry.childWorkItemId, outputName: 'change' })),
          },
        });
      }
      await root.orchestration.recordDeliveryCandidate(
        caller,
        { candidateId, selectionRevision: selection.revision, repositories: repositoriesCommand },
        context(candidateId),
      );
    };
    const delegateStage = async (request: RunnerRequest): Promise<AgentRunnerResult> => {
      stages.push('delegate');
      const caller = await callerFor(request);
      if (children.length === 0) {
        const reservation = await root.orchestration.submitDelegation(
          caller,
          { cohortId: 'six', expectedPlanRevision: 0, assignments },
          context('reserve'),
        );
        children = reservation.children;
        return done;
      }
      await assemble(request);
      return done;
    };
    const qaStage = async (request: RunnerRequest): Promise<AgentRunnerResult> => {
      stages.push('qa');
      const caller = await callerFor(request);
      const run = (await root.execution.list()).find((entry) => entry.runId === request.runId)!;
      const prepared = run.workspace!.candidate!;
      for (const entry of prepared.repositories)
        expect(await git(entry.path, 'rev-parse', 'HEAD')).toBe(entry.revision);
      const missingConfiguration = qaRounds === 0;
      if (!missingConfiguration)
        for (const entry of prepared.repositories)
          expect(await git(entry.path, 'show', 'HEAD:integration-ready')).toBe('ready');
      await root.orchestration.recordDeliveryQa(
        caller,
        {
          qaId: `qa-${++qaRounds}`,
          candidateId: prepared.candidateId,
          verdict: missingConfiguration ? 'fail' : 'pass',
          revisions: prepared.repositories.map((entry) => ({
            resourceId: entry.resourceId,
            revision: entry.revision,
          })),
          environment: { available: true },
          findings: missingConfiguration ? ['Integration configuration is missing'] : [],
        },
        context(`qa-${qaRounds}`),
      );
      return missingConfiguration ? { ...done, output: '{"status":"FAILED"}' } : done;
    };
    const maintainStage = async (request: RunnerRequest): Promise<AgentRunnerResult> => {
      const maintenanceContext = (id: string) => context(id + '-' + candidates);
      stages.push('maintain');
      const caller = await callerFor(request);
      const run = (await root.execution.list()).find((entry) => entry.runId === request.runId)!;
      // Wake leases every open target; only those it names a reason for need repair.
      const targets = run.workspace!.maintenance!.targets.filter(
        (target) => target.reason !== undefined,
      );
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const id = ids.find(
          (candidate) => childOf(candidate).workItemId === target.childWorkItemId,
        )!;
        const repo = repoOf(id);
        // The agent decides how to repair: replay only this change onto the new integration head.
        await git(target.path, 'fetch', 'origin', 'main', target.revision);
        const old = await git(target.path, 'rev-parse', `${target.revision}~1`);
        await git(target.path, 'config', 'user.name', 'Maintainer');
        await git(target.path, 'config', 'user.email', 'maintainer@example.test');
        await git(target.path, 'checkout', '--detach', target.revision);
        await git(target.path, 'rebase', '--onto', 'origin/main', old);
        const revision = await git(target.path, 'rev-parse', 'HEAD');
        await git(target.path, 'push', '--force', 'origin', `HEAD:refs/heads/${target.branch}`);
        maintained.set(id, revision);
        await writeProvider();
        const main = await git(paths[repo], 'rev-parse', 'main');
        const testedRevision = await git(
          paths[repo],
          'commit-tree',
          revision + '^{tree}',
          '-p',
          main,
          '-p',
          revision,
          '-m',
          'Test maintained subject',
        );
        const resource = (await root.pullRequests.get(target.resourceId as never))!;
        await root.pullRequests.observe(
          {
            ...resource,
            headRevision: revision,
            baseRevision: main,
            checks: 'passing',
            checkEvidence: {
              testedRevision: revision,
              headRevision: revision,
              baseRevision: main,
              startedAt: new Date().toISOString(),
            },
          },
          maintenanceContext('observe-maintained-' + id),
        );
        // Fresh review is part of the target's own consent policy.
        await root.pullRequests.acceptReviewSignal(
          {
            resourceId: target.resourceId as never,
            revision,
            actorId: 'reviewer',
            actorKind: 'human',
            acceptedEventId: 'review-' + id + '-' + revision,
            resourceAuthorId: 'author',
            authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
          },
          maintenanceContext('review-maintained-' + id),
        );
        const report = {
          maintenanceId: 'maintain-' + id + '-' + candidates,
          target: {
            childWorkItemId: workItemId(target.childWorkItemId),
            outputName: target.outputName,
          },
          kind: 'retarget' as const,
          expectedRevision: target.revision,
          revision,
          pullRequestBase: 'main',
        };
        await expect(
          root.orchestration.recordDeliveryMaintenance(
            caller,
            { ...report, pullRequestBase: 'forged-base' },
            maintenanceContext('bad-base-' + id),
          ),
        ).rejects.toThrow('provider must verify');
        await root.work.freeze(
          workItemId(target.childWorkItemId),
          maintenanceContext('freeze-' + id),
        );
        await expect(
          root.orchestration.recordDeliveryMaintenance(
            caller,
            report,
            maintenanceContext('frozen-' + id),
          ),
        ).rejects.toThrow('unavailable');
        await root.work.unfreeze(
          workItemId(target.childWorkItemId),
          maintenanceContext('unfreeze-' + id),
        );
        maintenanceRecords.push(id);
        await root.orchestration.recordDeliveryMaintenance(
          caller,
          {
            maintenanceId: `maintain-${id}-${candidates}`,
            target: {
              childWorkItemId: workItemId(target.childWorkItemId),
              outputName: target.outputName,
            },
            kind: 'retarget',
            expectedRevision: target.revision,
            revision,
            pullRequestBase: 'main',
          },
          maintenanceContext('maintain-' + id),
        );
        const checked = (await root.pullRequests.get(target.resourceId as never))!;
        // Exercise the same Actions provenance join used by the production GitHub source.
        const executionChecks = {
          available: true,
          complete: true,
          statuses: [],
          checkRuns: [
            {
              id: 99,
              head_sha: revision,
              check_suite: { id: 42 },
              status: 'completed',
              conclusion: 'success',
              started_at: new Date().toISOString(),
            },
          ],
        };
        const executionSubject = await verifiedCheckSubject(
          {
            listPullRequestFiles: async () => [],
            listCheckRunsForRef: async () => [],
            getCombinedStatusForRef: async () => [],
            checkExecution: async () => ({
              sha: testedRevision,
              parents: [{ sha: main }, { sha: revision }],
            }),
            workflowRunsForSuite: async () => [
              {
                id: 1,
                check_suite_id: 42,
                head_sha: revision,
                event: 'pull_request',
                status: 'completed',
                conclusion: 'success',
                pull_requests: [{ number: 7, head: { sha: revision }, base: { sha: main } }],
              },
            ],
          },
          'owner',
          repo,
          {
            number: 7,
            head: { sha: revision },
            base: { sha: main },
            merge_commit_sha: 'stale-test-merge',
          } as GitHubPullRequestPayload,
          executionChecks,
        );
        expect(executionSubject.checkEvidence).toBeDefined();
        await root.pullRequests.observe(
          {
            ...checked,
            checkEvidence: executionSubject.checkEvidence,
          },
          maintenanceContext('checks-after-subject-' + id),
        );
        expect(
          (
            await root.orchestration.recordDeliveryMaintenance(
              caller,
              report,
              maintenanceContext('duplicate-' + id),
            )
          ).replay,
        ).toBe(true);
      }
      return done;
    };
    runner.scriptFor = (request) =>
      request.prompt.includes('ASSEMBLE-STAGE')
        ? delegateStage
        : request.prompt.includes('QA-STAGE')
          ? qaStage
          : request.prompt.includes('MAINTAIN-STAGE')
            ? maintainStage
            : request.prompt.includes('Deliver the assignment')
              ? act
              : undefined;

    // --- Child scripts --------------------------------------------------------------------
    async function act(request: RunnerRequest): Promise<AgentRunnerResult> {
      const path = request.workspacePath!;
      const id = await childIdFor(request);
      await git(path, 'fetch', 'origin', heads.get(id)!);
      await git(path, 'merge', '--ff-only', heads.get(id)!);
      await git(path, 'push', 'origin', 'HEAD:refs/heads/' + childOf(id).workItemId);
      if (id === 'a1') {
        const workflow = (await root.orchestration.get(childOf(id).workflowInstanceId))!;
        await root.artifacts.stageRevision(
          {
            revisionId: 'api-contract-v1',
            path: 'contract.md',
            bytes: new TextEncoder().encode('Exact contract v1'),
          },
          {
            workItemId: childOf(id).workItemId,
            producer: childOf(id).workflowInstanceId + '/implement',
            activationId: workflow.pendingActivation!.activationId,
            runId: request.runId,
          },
          context('contract'),
        );
      }
      return {
        ...done,
        output: JSON.stringify({
          status: 'DONE',
          reportedArtifacts: [
            {
              name: 'change',
              kind: 'pull-request',
              externalKey: { adapter: 'fake', key: pullKey(id) },
            },
          ],
        }),
      };
    }

    const childIdFor = async (request: RunnerRequest) => {
      const run = (await root.execution.list()).find((entry) => entry.runId === request.runId)!;
      return ids.find((id) => childOf(id).workflowInstanceId === run.workflowInstanceId)!;
    };

    const awaitRuns = settle;
    const acceptLatest = async (child: Child) => {
      const last = (await root.execution.list())
        .filter((run) => run.workflowInstanceId === child.workflowInstanceId)
        .at(-1);
      expect(last?.status, JSON.stringify(last)).toBe('succeeded');
      const view = (await root.orchestration.get(child.workflowInstanceId))!;
      if (!view.acceptedOutcomes.includes(last!.activationId))
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: child.workflowInstanceId,
            activationId: last!.activationId,
            outcome: last!.outcome!,
          },
          context('accept-' + last!.runId),
        );
    };
    const expectRegistered = async (id: string) => {
      await root.processorRuntime.catchUp('register-pr-' + id);
      if ((await root.resources.findByExternalKey({ adapter: 'fake', key: pullKey(id) })) === null)
        throw new Error(
          'PR not registered ' +
            JSON.stringify(
              (await root.execution.list()).filter(
                (run) => run.workflowInstanceId === childOf(id).workflowInstanceId,
              ),
            ),
        );
    };
    const observeOpen = async (id: string) => {
      const resource = (await root.resources.findByExternalKey({
        adapter: 'fake',
        key: pullKey(id),
      }))!;
      const base = stackBase(id);
      await root.pullRequests.observe(
        {
          resourceId: resource.resourceId,
          workItemId: childOf(id).workItemId,
          state: PullRequestState.Open,
          headRevision: heads.get(id)!,
          baseRevision: base === undefined ? sources.get(repoOf(id))! : heads.get(base)!,
          checks: 'passing',
        },
        context('observe-' + id),
      );
      await root.pullRequests.acceptReviewSignal(
        {
          resourceId: resource.resourceId,
          revision: heads.get(id)!,
          actorId: 'reviewer',
          actorKind: 'human',
          acceptedEventId: 'review-' + id,
          resourceAuthorId: 'author',
          authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
        },
        context('review-' + id),
      );
    };
    const dispatchChild = async (id: string) => {
      const child = childOf(id);
      await root.advanceOnce({ workItemId: child.workItemId, maxProgress: 1 });
      await awaitRuns();
      await acceptLatest(child);
      if ((await root.orchestration.get(child.workflowInstanceId))!.currentStage === 'review') {
        await expectRegistered(id);
        await observeOpen(id);
      }
      await root.orchestration.reconcileChildCompletions(context('reconcile-' + id));
    };

    // --- Delegate, then run every child through its normal multistage workflow ------------
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await awaitRuns();
    expect(children).toHaveLength(6);
    await writeProvider();
    root = await open();
    for (let round = 0; round < 12; round++) {
      let progressed = false;
      for (const id of ids) {
        const view = await root.orchestration.get(childOf(id).workflowInstanceId);
        if (view === null || view.status === 'completed') continue;
        await dispatchChild(id);
        progressed = true;
      }
      if (!progressed) break;
    }
    const childStatuses = async () =>
      JSON.stringify(
        await Promise.all(
          ids.map(async (id) => [
            id,
            (await root.orchestration.get(childOf(id).workflowInstanceId))?.status ?? 'queued',
          ]),
        ),
      );
    expect(await childStatuses()).not.toContain('queued');
    expect(await childStatuses()).not.toContain('active');
    await root.orchestration.reconcileChildCompletions(context('join'));
    const childRun = (await root.execution.list()).find(
      (entry) => entry.workflowInstanceId === childOf('a1').workflowInstanceId,
    )!;
    expect(
      await root.orchestration.authorizeParentAction({
        workflowInstanceId: childRun.workflowInstanceId,
        activationId: childRun.activationId,
        action: ParentActionKind.Merge,
      }),
    ).toEqual({ kind: 'denied', reason: 'outside-delivery' });

    // --- The parent assembles, QA passes, then Wake drives governed integration ------------
    const parentStatus = async () => (await root.orchestration.get(parent.workflowInstanceId))!;
    for (let pass = 0; pass < 40 && (await parentStatus()).status !== 'completed'; pass++) {
      await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await awaitRuns();
      // Delivery lane: requested merges reach the provider fixture and their results return.
      await createOneShotRunnerAdvance(root)({ maxProgress: 1 });
      await awaitRuns();
      // Restart between steps: every decision must be recomputed from durable facts.
      if (pass % 3 === 2) root = await open();
    }
    const finalParent = await parentStatus();
    if (finalParent.status !== 'completed') {
      throw new Error(
        JSON.stringify({
          stages,
          mergeEvents,
          status: finalParent.status,
          stage: finalParent.currentStage,
          reason: finalParent.blockReason,
          last: finalParent.lastOutcome,
          summary: (await root.orchestration.deliveryStateFor(parent.workflowInstanceId))
            .integration?.summary,
        }),
      );
    }
    expect(finalParent.status, JSON.stringify({ stages, mergeEvents, finalParent })).toBe(
      'completed',
    );
    expect(mergeEvents.sort()).toEqual([...ids].sort());
    expect(maintenanceRecords).toEqual(expect.arrayContaining(['a2', 'b2']));
    expect(plannedMovementTargets.some((id) => repoOf(id) === 'a')).toBe(true);
    expect(plannedMovementTargets.some((id) => repoOf(id) === 'b')).toBe(true);
    expect(qaRounds).toBe(stages.filter((stage) => stage === 'maintain').length + 2);
    // Child-owned pull requests keep their original owner; the parent never became owner.
    for (const id of ids) {
      const resource = (await root.resources.findByExternalKey({
        adapter: 'fake',
        key: pullKey(id),
      }))!;
      expect(await root.resources.primaryCorrelation(resource.resourceId)).toMatchObject({
        workItemId: childOf(id).workItemId,
      });
      expect((await root.pullRequests.get(resource.resourceId))!.state).toBe(
        PullRequestState.Merged,
      );
    }
    for (const id of ids)
      expect((await root.orchestration.get(childOf(id).workflowInstanceId))!.status).toBe(
        'completed',
      );
    // Every merge was requested by the parent for a child-owned pull request, at the exact
    // recorded head, and none of them consumed a defect-correction round.
    const facts = await journal.readAll(0);
    const merges = facts.filter(
      (entry) => entry.event.eventType === ActivityEventType.PrMergeRequested,
    );
    expect(merges).toHaveLength(6);
    for (const entry of merges) {
      const payload = entry.event.payload as {
        parent?: { requestingWorkItemId: string; ownerWorkItemId: string };
      };
      expect(payload.parent?.requestingWorkItemId).toBe(parentWork);
      expect(payload.parent?.ownerWorkItemId).not.toBe(parentWork);
    }
    const state = await root.orchestration.deliveryStateFor(parent.workflowInstanceId);
    expect(state.history).toHaveLength(qaRounds);
    expect(state.maintenance).toHaveLength(maintenanceRecords.length);
    // The actual producer of each new subject is the parent's maintenance Run, not the child's.
    for (const item of state.maintenance) {
      const run = (await root.execution.list()).find(
        (entry) => entry.runId === item.producer.runId,
      );
      expect(run?.workflowInstanceId).toBe(parent.workflowInstanceId);
      expect(item.previous.revision).not.toBe(item.current.revision);
    }
    const presented = await presentDelivery(root, (await root.work.get(parentWork))!);
    expect(presented.delegation?.qa?.integration).toMatchObject({
      complete: true,
      targets: expect.any(Array),
    });
    expect(presented.delegation?.qa?.integration?.maintenance).toHaveLength(
      maintenanceRecords.length,
    );
    expect(state.integration).toMatchObject({ complete: true });
    expect(state.repair.failedRounds).toBe(1);
    expect(state.completion).toEqual({ complete: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 240_000);

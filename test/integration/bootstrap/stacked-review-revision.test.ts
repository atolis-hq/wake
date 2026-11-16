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
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import { isActiveRunStatus, RunStatus, type RunnerRequest } from '../../../src/execution/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
  workflowName,
  type DelegationReservation,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { ScriptedDelegationRunner } from '../../support/scripted-delegation-runner.js';

const exec = promisify(execFile);
const git = async (path: string, ...args: string[]) =>
  (await exec('git', ['-C', path, ...args])).stdout.trim();
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('revision-stack'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'test' },
});
const done = { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };

it.each(['recover', 'in-review', 'terminal', 'stale'])(
  'handles a pushed-change review stack safely (%s)',
  async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), 'wake-stack-review-'));
    let shutdown = async () => {};
    try {
      const repo = join(home, 'repo');
      await exec('git', ['init', '-b', 'main', repo]);
      await git(repo, 'config', 'user.name', 'Fixture');
      await git(repo, 'config', 'user.email', 'fixture@example.test');
      const commit = async (name: string) => {
        await writeFile(join(repo, name), name);
        await git(repo, 'add', '.');
        await git(repo, 'commit', '-m', name);
        return git(repo, 'rev-parse', 'HEAD');
      };
      const source = await commit('source');
      const heads = new Map<string, string>();
      for (const id of ['one', 'two', 'three']) heads.set(id, await commit(id));
      await git(repo, 'switch', '-c', 'revised', heads.get('two')!);
      const revised = await commit('revision');
      await git(repo, 'cherry-pick', heads.get('three')!);
      const refreshed = await git(repo, 'rev-parse', 'HEAD');
      await git(repo, 'switch', 'main');
      await git(repo, 'reset', '--hard', source);
      heads.set('independent', await commit('independent'));
      await git(repo, 'reset', '--hard', source);
      const eventsFile = join(home, 'provider.json');
      const runner = new ScriptedDelegationRunner();
      const journal = new InMemoryEventJournal({ now: () => new Date() });
      const repository = resId('review-stack');
      const parentWork = workId('review-stack');
      let children: DelegationReservation['children'] = [];
      const child = (id: string) => children.find((entry) => entry.assignmentId === id)!;
      const upstream = (id: string) => (id === 'two' ? 'one' : id === 'three' ? 'two' : undefined);
      const publish = () =>
        writeFile(
          eventsFile,
          JSON.stringify(
            children.map((entry, index) => ({
              key: `org/repo#${index + 1}`,
              kind: 'pull-request',
              title: entry.assignmentId,
              revision: heads.get(entry.assignmentId),
              branch: entry.workItemId,
              baseBranch:
                upstream(entry.assignmentId) === undefined
                  ? 'main'
                  : child(upstream(entry.assignmentId)!).workItemId,
              baseRevision:
                upstream(entry.assignmentId) === undefined
                  ? source
                  : heads.get(upstream(entry.assignmentId)!),
              acceptedReview: true,
              checks: 'passing',
            })),
          ),
        );
      await publish();
      const stage = (workspace: string) => ({
        activity: 'agent',
        with: { prompt: 'Deliver assignment' },
        execution: { workspace },
        requiresApproval: false,
        on: {
          failed: { then: 'done' },
          done: { then: 'done', watchGates: [{ watch: 'review', onReject: { then: 'revise' } }] },
        },
      });
      const open = () =>
        createCompositionRoot(home, {
          config: parseRootConfig({
            execution: {
              agentRunners: { fake: { kind: 'fake' } },
              runnerPools: { standard: ['fake'] },
              defaultRunnerPool: 'standard',
            },
            integrations: { fake: { enabled: true, eventsFile } },
            orchestration: {
              default: 'parent',
              workflows: {
                parent: {
                  delegation: {
                    workflows: ['child', 'independent'],
                    maxDepth: 1,
                    maxDescendants: 4,
                    maxConcurrentRuns: 4,
                  },
                  stages: {
                    delegate: {
                      activity: 'agent',
                      with: { prompt: 'Delegate' },
                      execution: { workspace: 'none' },
                      on: { done: { then: 'done' } },
                    },
                  },
                },
                child: {
                  stages: { implement: stage('branch'), revise: stage('branch') },
                  watches: [
                    {
                      id: 'review',
                      while: { stages: ['implement', 'revise'], statuses: ['waiting'] },
                      on: { events: ['orchestration.signal-wait-started'] },
                      workflow: 'review',
                      maxPerGroup: 5,
                    },
                  ],
                },
                independent: {
                  stages: {
                    hold: {
                      activity: 'agent',
                      with: { prompt: 'Independent sibling' },
                      execution: { workspace: 'none' },
                      on: { done: { then: 'done', await: { signal: 'release', from: ['human'] } } },
                    },
                  },
                },
                review: {
                  stages: {
                    review: {
                      activity: 'agent',
                      with: { prompt: 'Review' },
                      requiresApproval: false,
                      execution: { workspace: 'none' },
                      on: { done: { then: 'done' }, rejected: { then: 'done' } },
                    },
                  },
                },
              },
            },
          }),
          journal,
          checkpoints: new InMemoryCheckpointStore(),
          projections: new InMemoryProjectionStore(),
          decorateRunner: () => runner,
          decorateRepositoryCloneResolver: () => ({ cloneLocator: async () => repo }),
        });
      let root = await open();
      shutdown = () => root.execution.shutdown();
      await root.work.create(
        { workItemId: parentWork, objective: 'Review stack recovery' },
        context('create'),
      );
      await root.resources.discover(
        {
          resourceId: repository,
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'fake', key: 'org/repo' },
          capabilities: [],
        },
        context('repo'),
      );
      await root.resources.correlate(
        repository,
        parentWork,
        ResourceCorrelationRole.Secondary,
        context('scope'),
      );
      const parent = await root.orchestration.start(
        {
          workItemId: parentWork,
          workflowInstanceId: workflowInstanceId('revision-parent'),
          workflowName: workflowName('parent'),
          orchestrationGroupId: orchestrationGroupId('revision-parent'),
        },
        context('start'),
      );
      const idle = () =>
        vi.waitFor(
          async () =>
            expect(
              (await root.execution.list()).every(
                (run) =>
                  !isActiveRunStatus(run.status) && !root.execution.isLocallyActive(run.runId),
              ),
            ).toBe(true),
          { timeout: 15_000 },
        );
      runner.scripts.push(async (request) => {
        children = (
          await root.orchestration.submitDelegation(
            {
              workflowInstanceId: parent.workflowInstanceId,
              activationId: parent.pendingActivation!.activationId,
              runId: request.runId,
            },
            {
              cohortId: 'stack',
              expectedPlanRevision: 0,
              assignments: ['one', 'two', 'three', 'independent'].map((id) => ({
                assignmentId: id,
                objective: id,
                criteria: ['Publish tested change'],
                workflowName: workflowName(id === 'independent' ? 'independent' : 'child'),
                context: [],
                repository: { resourceId: repository, sourceRef: 'main', pullRequestBase: 'main' },
                outputs:
                  id === 'independent'
                    ? [{ name: 'note', path: 'note.md' }]
                    : [
                        {
                          name: 'change',
                          kind: 'change',
                          requireReview: false,
                          requireChecks: false,
                        },
                      ],
                prerequisites:
                  upstream(id) === undefined
                    ? []
                    : [
                        {
                          assignmentId: upstream(id)!,
                          output: 'change',
                          condition: 'pushed-change',
                          useAsBase: true,
                        },
                      ],
              })),
            },
            context('reserve'),
          )
        ).children;
        await publish();
        return done;
      });
      let rejectedTwo = false;
      runner.scriptFor = (request) =>
        request.prompt.startsWith('Review')
          ? async (request) => {
              const run = (await root.execution.list()).find((run) => run.runId === request.runId)!;
              const watch = (await root.orchestration.get(
                workflowInstanceId(run.workflowInstanceId),
              ))!;
              const reject =
                watch.parentWorkflowInstanceId === child('two').workflowInstanceId && !rejectedTwo;
              if (reject) rejectedTwo = true;
              return { ...done, output: JSON.stringify({ status: reject ? 'REJECTED' : 'DONE' }) };
            }
          : request.prompt.includes('Independent sibling')
            ? async (request) => {
                const entry = child('independent');
                const view = (await root.orchestration.get(entry.workflowInstanceId))!;
                await root.artifacts.stageRevision(
                  {
                    revisionId: 'sibling-note',
                    path: 'note.md',
                    bytes: new TextEncoder().encode('Independent'),
                  },
                  {
                    workItemId: entry.workItemId,
                    producer: entry.workflowInstanceId + '/hold',
                    activationId: view.pendingActivation!.activationId,
                    runId: request.runId,
                  },
                  context('sibling-note'),
                );
                return done;
              }
            : undefined;
      await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await idle();
      const implement = async (id: string, expectedBase: string, target: string) => {
        const entry = child(id);
        const current = (await root.orchestration.get(entry.workflowInstanceId))!;
        const existing = (await root.execution.list()).find(
          (run) =>
            run.activationId === current.pendingActivation?.activationId &&
            run.status === 'succeeded',
        );
        if (existing === undefined) {
          runner.scripts.push(async (request: RunnerRequest) => {
            const path = request.workspacePath!;
            // A refresh reuses the existing checkout. The fake agent owns the Git operation.
            if (id !== 'three' || target !== refreshed)
              expect(await git(path, 'rev-parse', 'HEAD')).toBe(expectedBase);
            else {
              expect(request.prompt).toContain('Assess and refresh');
              expect(request.prompt).toContain(revised);
            }
            await git(path, 'fetch', 'origin', target);
            await git(path, 'reset', '--hard', target);
            await git(
              path,
              'push',
              '--force-with-lease',
              'origin',
              'HEAD:refs/heads/' + entry.workItemId,
            );
            return {
              ...done,
              output: JSON.stringify({
                status: 'DONE',
                reportedArtifacts: [
                  {
                    name: 'change',
                    kind: 'pull-request',
                    externalKey: {
                      adapter: 'fake',
                      key: `org/repo#${children.indexOf(entry) + 1}`,
                    },
                  },
                ],
              }),
            };
          });
          await root.advanceOnce({ workItemId: entry.workItemId, maxProgress: 1 });
          await idle();
        }
        const run = (await root.execution.list())
          .filter((run) => run.workflowInstanceId === entry.workflowInstanceId)
          .at(-1)!;
        expect(run.status, JSON.stringify(run.failure)).toBe('succeeded');
        const view = (await root.orchestration.get(entry.workflowInstanceId))!;
        if (!view.acceptedOutcomes.includes(run.activationId))
          await root.orchestration.acceptOutcome(
            {
              workflowInstanceId: entry.workflowInstanceId,
              activationId: run.activationId,
              outcome: run.outcome!,
            },
            context('accept-' + run.runId),
          );
        await root.processorRuntime.catchUp('register-pr');
        const resource = (await root.resources.findByExternalKey({
          adapter: 'fake',
          key: `org/repo#${children.indexOf(entry) + 1}`,
        }))!;
        expect(resource).not.toBeNull();
        await root.pullRequests.observe(
          {
            resourceId: resource.resourceId,
            workItemId: entry.workItemId,
            state: 'open',
            headRevision: target,
            baseRevision: expectedBase,
            checks: 'passing',
          },
          context('observe-' + run.runId),
        );
        await root.orchestration.reconcileChildCompletions(context('reconcile-' + run.runId));
      };
      const review = async (id: string, reject = false) => {
        const entry = child(id);
        if (
          !reject &&
          (await root.orchestration.get(entry.workflowInstanceId))!.status === 'completed'
        )
          return;
        const views = await root.orchestration.listAll();
        const watch = views.find(
          (view) =>
            view.parentWorkflowInstanceId === entry.workflowInstanceId &&
            view.pendingActivation !== undefined &&
            view.status === 'active',
        )!;
        expect(watch).toBeDefined();
        await root.advanceOnce({ workItemId: entry.workItemId, maxProgress: 1 });
        await idle();
        const run = (await root.execution.list()).find(
          (run) => run.activationId === watch.pendingActivation!.activationId,
        )!;
        expect(run.status).toBe('succeeded');
        expect(run.outcome?.kind).toBe(reject ? 'rejected' : 'done');
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: watch.workflowInstanceId,
            activationId: run.activationId,
            outcome: run.outcome!,
          },
          context('review-' + run.runId),
        );
        await root.orchestration.reconcileChildCompletions(
          context('review-reconcile-' + watch.workflowInstanceId),
        );
      };
      await implement('one', source, heads.get('one')!);
      await review('one');
      await implement('two', heads.get('one')!, heads.get('two')!);
      await implement('three', heads.get('two')!, heads.get('three')!);
      // Layer three may even finish before layer two's review rejects.
      const oldReview = (await root.orchestration.listAll()).find(
        (view) => view.parentWorkflowInstanceId === child('three').workflowInstanceId,
      )!;
      if (scenario !== 'in-review') await review('three');
      const before = (await root.orchestration.deliveryTree(parentWork))[0]!.children.find(
        (entry) => entry.assignmentId === 'three',
      )!.consumedInputs!;
      await review('two', true);
      expect(
        await root.orchestration.listPendingActivations(child('three').workItemId),
      ).toHaveLength(0);
      expect(
        (await root.orchestration.deliveryTree(parentWork))[0]!.children.find(
          (entry) => entry.assignmentId === 'independent',
        )!.prerequisiteBlocker,
      ).toBeUndefined();
      expect(
        await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'stack'),
      ).toHaveLength(0);
      if (scenario === 'terminal') {
        runner.scripts.push(async () => ({ ...done, output: '{"status":"FAILED"}' }));
        await root.advanceOnce({ workItemId: child('two').workItemId, maxProgress: 1 });
        await idle();
        const run = (await root.execution.list())
          .filter((entry) => entry.workflowInstanceId === child('two').workflowInstanceId)
          .at(-1)!;
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: child('two').workflowInstanceId,
            activationId: run.activationId,
            outcome: run.outcome!,
          },
          context('accept-terminal'),
        );
        await root.orchestration.reconcileChildCompletions(context('terminal'));
        const tree = (await root.orchestration.deliveryTree(parentWork))[0]!;
        expect(
          tree.children.find((entry) => entry.assignmentId === 'three')!.prerequisiteBlocker,
        ).toBeDefined();
        expect(
          (await root.orchestration.deliveryTree(parentWork))[0]!.children.find(
            (entry) => entry.assignmentId === 'independent',
          )!.prerequisiteBlocker,
        ).toBeUndefined();
        expect(
          (await journal.readAll(0)).some(
            ({ event }) => event.eventType === OrchestrationEventType.DelegationAttentionRequested,
          ),
        ).toBe(true);
        return;
      }
      heads.set('two', revised);
      await publish();
      await implement('two', await git(repo, 'rev-parse', revised + '^'), revised);
      // Reconciliation schedules a fresh assessment; no stale selected result can join.
      const pending = (
        await root.orchestration.listPendingActivations(child('three').workItemId)
      ).filter((entry) => entry.workflow.workflowInstanceId === child('three').workflowInstanceId);
      expect(pending).toHaveLength(1);
      expect(
        await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'stack'),
      ).toHaveLength(0);
      const after = (await root.orchestration.deliveryTree(parentWork))[0]!.children.find(
        (entry) => entry.assignmentId === 'three',
      )!.consumedInputs!;
      expect(after.repository?.sourceRevision).toBe(revised);
      expect(before.repository?.sourceRevision).not.toBe(revised);
      await root.execution.shutdown();
      root = await open();
      expect(
        (await root.orchestration.listPendingActivations(child('three').workItemId)).filter(
          (entry) => entry.workflow.workflowInstanceId === child('three').workflowInstanceId,
        ),
      ).toHaveLength(1);
      if (scenario === 'stale') {
        runner.scripts.push(async () => done);
        await root.advanceOnce({ workItemId: child('three').workItemId, maxProgress: 1 });
        await idle();
        const run = (await root.execution.list())
          .filter((entry) => entry.workflowInstanceId === child('three').workflowInstanceId)
          .at(-1)!;
        expect(run.status).toBe('failed');
        expect(run.failure?.message).toContain('merge-base');
        expect(
          (await root.orchestration.get(child('three').workflowInstanceId))!.acceptedOutcomes,
        ).not.toContain(run.activationId);
        expect(
          await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'stack'),
        ).toHaveLength(0);
        return;
      }
      heads.set('three', refreshed);
      await publish();
      await implement('three', revised, refreshed);
      if (scenario === 'in-review') {
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: oldReview.workflowInstanceId,
            activationId: oldReview.pendingActivation!.activationId,
            outcome: { kind: 'done' },
          },
          context('late-old-review'),
        );
        await root.orchestration.reconcileChildCompletions(context('ignore-old-review'));
        expect(
          (await root.orchestration.get(child('three').workflowInstanceId))!
            .acceptedChildCompletionIds,
        ).not.toContain(oldReview.workflowInstanceId);
      }
      await review('two');
      await review('three');
      const sibling = child('independent');
      const siblingRun = (await root.execution.list()).find(
        (run) => run.workflowInstanceId === sibling.workflowInstanceId,
      )!;
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: sibling.workflowInstanceId,
          activationId: siblingRun.activationId,
          outcome: siblingRun.outcome!,
        },
        context('accept-sibling'),
      );
      await root.orchestration.acceptSignal(
        child('independent').workflowInstanceId,
        {
          kind: signalName('release'),
          actorId: 'fixture',
          actorDecision: { authorized: true, evidenceId: 'release' },
          providerEventId: 'release',
          authority: { kind: 'human' },
        },
        context('release'),
      );
      await root.orchestration.reconcileChildCompletions(context('independent-complete'));
      await root.orchestration.reconcileChildCompletions(context('join'));
      expect(
        await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'stack'),
      ).toHaveLength(4);
      const facts = await journal.readAll(0);
      expect(
        facts.filter(
          ({ event }) => event.eventType === OrchestrationEventType.DelegationAttentionRequested,
        ),
      ).toHaveLength(0);
      expect(
        facts.filter(
          ({ event }) => event.eventType === OrchestrationEventType.DelegationInputsRefreshed,
        ),
      ).toHaveLength(1);
      expect(
        facts.filter(
          ({ event }) => event.eventType === OrchestrationEventType.DelegationInputsResolved,
        ),
      ).toHaveLength(2);
    } finally {
      await shutdown();
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);

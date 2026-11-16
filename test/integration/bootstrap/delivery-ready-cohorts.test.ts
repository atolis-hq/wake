import { correlationId, createEventData, EventProcessorHost } from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
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
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  isActiveRunStatus,
  RunRepository,
  RunStatus,
  type RunnerRequest,
} from '../../../src/execution/index.js';
import {
  BuiltInAdapterId,
  GitHubEventType,
  InboundTranslator,
  integrationStream,
} from '../../../src/integrations/github/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  selectWorkflowOrchestrationEvent,
  workflowInstanceId,
  workflowName,
  type DelegationReservation,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../../src/resources/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
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

it('accepts delivery-ready outputs across cohorts and releases the next reviewed child', async () => {
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
    for (const id of ['two', 'three', 'four', 'five']) heads.set(id, await commit(id));
    await git(repo, 'reset', '--hard', source);
    const eventsFile = join(home, 'provider.json');
    const runner = new ScriptedDelegationRunner();
    const journal = new InMemoryEventJournal({ now: () => new Date() });
    const repository = resId('review-stack');
    const parentWork = workId('review-stack');
    let children: DelegationReservation['children'] = [];
    const child = (id: string) => children.find((entry) => entry.assignmentId === id)!;
    const upstream = (id: string) => ({ three: 'two', four: 'three', five: 'four' })[id];
    const publish = () =>
      writeFile(
        eventsFile,
        JSON.stringify(
          children.map((entry, index) => ({
            key: `org/repo#${index + 1}`,
            kind: 'pull-request',
            title: entry.assignmentId,
            revision: heads.get(entry.assignmentId) ?? source,
            branch: entry.workItemId,
            baseBranch:
              upstream(entry.assignmentId) === undefined
                ? 'main'
                : child(upstream(entry.assignmentId)!).workItemId,
            baseRevision:
              upstream(entry.assignmentId) === undefined
                ? source
                : heads.get(upstream(entry.assignmentId)!),
            acceptedReview: false,
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
        blocked: { then: 'done' },
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
                  maxDescendants: 8,
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
                stages: {
                  implement: stage('branch'),
                  revise: stage('branch'),
                },
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
                    execution: { workspace: 'read-only' },
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
              (run) => !isActiveRunStatus(run.status) && !root.execution.isLocallyActive(run.runId),
            ),
          ).toBe(true),
        { timeout: 15_000 },
      );
    const submit = async (
      request: RunnerRequest,
      cohortId: string,
      ids: string[],
      revision: number,
    ) => {
      const current = (await root.orchestration.get(parent.workflowInstanceId))!;
      const reservation = await root.orchestration.submitDelegation(
        {
          workflowInstanceId: parent.workflowInstanceId,
          activationId: current.pendingActivation!.activationId,
          runId: request.runId,
        },
        {
          cohortId,
          expectedPlanRevision: revision,
          assignments: ids.map((id) => ({
            assignmentId: id,
            ...(cohortId === 'replacement'
              ? { replaces: { cohortId: 'original', assignmentId: 'old-' + id } }
              : {}),
            objective: id,
            criteria: ['Publish tested change'],
            workflowName: workflowName('child'),
            context: [],
            repository: { resourceId: repository, sourceRef: 'main', pullRequestBase: 'main' },
            outputs: [
              {
                name: 'change',
                kind: 'change' as const,
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
                      ...(id === 'three' ? { cohortId: 'original' } : {}),
                      output: 'change',
                      condition: 'delivery-ready' as const,
                      useAsBase: true,
                    },
                  ],
          })),
        },
        context('submit-' + cohortId),
      );
      children = [...children, ...reservation.children];
      await publish();
      return done;
    };
    runner.scriptFor = (request) => {
      if (request.prompt.startsWith('Deliver assignment'))
        return async (request) => {
          const run = (await root.execution.list()).find((run) => run.runId === request.runId)!;
          if (
            children.some(
              (child) =>
                child.assignmentId.startsWith('old-') &&
                child.workflowInstanceId === run.workflowInstanceId,
            )
          )
            return { ...done, output: '{"status":"FAILED"}' };
          const script = runner.scripts.shift();
          return script === undefined ? done : script(request);
        };
      return request.prompt.startsWith('Review') ? async () => done : undefined;
    };
    runner.scripts.push((request) =>
      submit(request, 'original', ['two', 'old-three', 'old-four', 'old-five'], 0),
    );
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await idle();

    const implement = async (id: string) => {
      const entry = child(id);
      runner.scripts.push(async (request) => {
        const path = request.workspacePath!;
        await git(path, 'fetch', 'origin', heads.get(id)!);
        await git(path, 'reset', '--hard', heads.get(id)!);
        await git(path, 'push', 'origin', 'HEAD:refs/heads/' + entry.workItemId);
        return {
          ...done,
          output: JSON.stringify({
            status: 'DONE',
            reportedArtifacts: [
              {
                name: 'change',
                kind: 'pull-request',
                externalKey: { adapter: 'fake', key: 'org/repo#' + (children.indexOf(entry) + 1) },
              },
            ],
          }),
        };
      });
      await root.advanceOnce({ workItemId: entry.workItemId, maxProgress: 1 });
      await idle();
      const run = (await root.execution.list())
        .filter((run) => run.workflowInstanceId === entry.workflowInstanceId)
        .at(-1)!;
      expect(run.status, JSON.stringify(run.failure)).toBe('succeeded');
      if (id === 'three') {
        const upstreamResource = (await root.resources.findByExternalKey({
          adapter: 'fake',
          key: 'org/repo#1',
        }))!;
        const observed = (await root.pullRequests.get(upstreamResource.resourceId))!;
        await root.pullRequests.observe(
          { ...observed, checks: 'failing' },
          context('upstream-checks-fail'),
        );
        await expect(
          root.orchestration.acceptOutcome(
            {
              workflowInstanceId: entry.workflowInstanceId,
              activationId: run.activationId,
              outcome: run.outcome!,
            },
            context('fenced-outcome'),
          ),
        ).rejects.toThrow('delegation');
        const detail = await (
          await createSurfaceApplications(root)
        ).api.work.detail(toWorkItemKey(parentWork));
        const row = detail!.data.delegation!.children.find(
          (row) => row.workItemId === entry.workItemId,
        )!;
        expect(row.prerequisiteBlocker).toContain('delivery-ready output two/change');
        expect(row.prerequisiteBlocker).toContain('checks-failing');
        expect(row.blockReason).toBe(row.prerequisiteBlocker);
        await root.pullRequests.observe(
          { ...observed, checks: 'passing' },
          context('upstream-checks-restored'),
        );
      }
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: entry.workflowInstanceId,
          activationId: run.activationId,
          outcome: run.outcome!,
        },
        context('accept-' + id),
      );
      expect((await root.orchestration.get(entry.workflowInstanceId))!.acceptedOutcomes).toContain(
        run.activationId,
      );
      await root.processorRuntime.catchUp('register-' + id);
      const resource = (await root.resources.findByExternalKey({
        adapter: 'fake',
        key: 'org/repo#' + (children.indexOf(entry) + 1),
      }))!;
      await root.pullRequests.observe(
        {
          resourceId: resource.resourceId,
          workItemId: entry.workItemId,
          state: 'open',
          headRevision: heads.get(id)!,
          baseRevision: upstream(id) === undefined ? source : heads.get(upstream(id)!)!,
          checks: 'passing',
        },
        context('observe-' + id),
      );
      await root.orchestration.reconcileChildCompletions(context('reconcile-' + id));
    };
    const review = async (id: string) => {
      const entry = child(id);
      const watch = (await root.orchestration.listAll()).find(
        (view) =>
          view.parentWorkflowInstanceId === entry.workflowInstanceId && view.status === 'active',
      )!;
      expect(watch).toBeDefined();
      await root.advanceOnce({ workItemId: entry.workItemId, maxProgress: 1 });
      await idle();
      const run = (await root.execution.list()).find(
        (run) => run.activationId === watch.pendingActivation!.activationId,
      )!;
      expect(run.status, JSON.stringify(run.failure)).toBe('succeeded');
      expect(run.workspaceRevision).toBe(heads.get(id));
      if (id === 'three') {
        // Let the observed comment win the race against internal child completion.
        const stream = integrationStream(BuiltInAdapterId.GitHub);
        const eventId = 'github:comment:review-three';
        await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
          createEventData({
            eventId,
            eventType: GitHubEventType.CommentObserved,
            occurredAt: new Date().toISOString(),
            correlationId: eventId,
            causationId: eventId,
            actor: { kind: 'integration', id: 'github' },
            source: { kind: 'adapter', id: 'github' },
            payload: {
              reviewKind: 'issue',
              externalKey: 'org/repo#5',
              body:
                '\x60\x60\x60json\n' +
                JSON.stringify({
                  wake: { watchGateVerdict: { runId: run.runId, outcome: 'DONE' } },
                }) +
                '\n\x60\x60\x60',
              revision: new Date().toISOString(),
              actor: { id: 'wake-bot', kind: 'bot' },
              raw: { id: 5 },
            },
          }),
        ]);
        const translator = new InboundTranslator(journal, root.work, root.resources, {
          orchestration: root.orchestration,
          runs: new RunRepository(journal),
        });
        await new EventProcessorHost(
          journal,
          new InMemoryCheckpointStore(),
          createInMemoryProcessorRunSerialiser(),
          { now: () => new Date() },
        ).runThrough(translator.processor, await journal.latestGlobalPosition());
        const accepted = (await journal.readAll(0))
          .map(selectWorkflowOrchestrationEvent)
          .find(
            (event) =>
              event?.stream.id === entry.workflowInstanceId &&
              event.event.eventType === OrchestrationEventType.SignalAccepted,
          );
        // Either the observed comment or internal completion may be accepted first.
        expect(accepted?.event.payload).toMatchObject({
          childWorkflowInstanceId: watch.workflowInstanceId,
        });
        expect([eventId, watch.workflowInstanceId]).toContain(
          (accepted?.event.payload as { providerEventId?: string } | undefined)?.providerEventId,
        );
        expect((await root.orchestration.get(entry.workflowInstanceId))!.status).toBe('completed');
      }
      await root.orchestration.acceptOutcome(
        {
          workflowInstanceId: watch.workflowInstanceId,
          activationId: run.activationId,
          outcome: run.outcome!,
        },
        context('review-' + id),
      );
      await root.orchestration.reconcileChildCompletions(context('reviewed-' + id));
    };
    await implement('two');
    await review('two');
    // The original downstream work failed. Keep its reviewed upstream available
    // while the parent replaces only the failed assignments in a later cohort.
    for (const id of ['old-three', 'old-four', 'old-five']) {
      const entry = child(id);
      await root.advanceOnce({ workItemId: entry.workItemId, maxProgress: 1 });
      await idle();
      const run = (await root.execution.list())
        .filter((run) => run.workflowInstanceId === entry.workflowInstanceId)
        .at(-1)!;
      expect(run.status).toBe('succeeded');
      if (
        !(await root.orchestration.get(entry.workflowInstanceId))!.acceptedOutcomes.includes(
          run.activationId,
        )
      )
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: entry.workflowInstanceId,
            activationId: run.activationId,
            outcome: run.outcome!,
          },
          context('fail-' + id),
        );
    }
    await root.orchestration.reconcileChildCompletions(context('join-original'));
    for (
      let attempt = 0;
      attempt < 3 &&
      (await root.orchestration.get(parent.workflowInstanceId))!.delegationAttention !== undefined;
      attempt++
    ) {
      runner.scripts.push(async () => done);
      await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
      await idle();
      const current = (await root.orchestration.get(parent.workflowInstanceId))!;
      const run = (await root.execution.list())
        .filter((run) => run.workflowInstanceId === parent.workflowInstanceId)
        .at(-1)!;
      if (!current.acceptedOutcomes.includes(run.activationId))
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: parent.workflowInstanceId,
            activationId: run.activationId,
            outcome: run.outcome!,
          },
          context('attention-' + attempt),
        );
      await root.orchestration.reconcileChildCompletions(context('settle-original-' + attempt));
    }
    expect(
      (await root.orchestration.deliveryTree(parentWork))[0]!.settled,
      JSON.stringify(await root.orchestration.deliveryTree(parentWork)),
    ).toBe(true);
    runner.scripts.push((request) => submit(request, 'replacement', ['three', 'four', 'five'], 1));
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await idle();
    expect(children).toHaveLength(7);
    expect(await root.orchestration.get(child('three').workflowInstanceId)).not.toBeNull();
    expect(await root.orchestration.get(child('four').workflowInstanceId)).toBeNull();
    await implement('three');
    const waiting = (
      await root.orchestration.deliveryTree(parentWork, { verify: true })
    )[1]!.children.find((entry) => entry.assignmentId === 'four')!;
    expect(waiting.prerequisiteBlocker).toContain('delivery-ready');
    await review('three');
    await root.orchestration.reconcileChildCompletions(context('start-four'));
    expect(await root.orchestration.get(child('four').workflowInstanceId)).not.toBeNull();
    await implement('four');
    await root.execution.shutdown();
    root = await open();
    expect(
      (await root.orchestration.deliveryTree(parentWork, { verify: true }))[1]!.children.find(
        (entry) => entry.assignmentId === 'three',
      )!.prerequisiteBlocker,
    ).toBeUndefined();
  } finally {
    await shutdown();
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

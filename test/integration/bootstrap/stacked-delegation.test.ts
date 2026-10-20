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
import { ArtifactContextService } from '../../../src/artifacts/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  isActiveRunStatus,
  RunStatus,
  type AgentRunnerResult,
  type RunnerRequest,
} from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
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
  correlationId: correlationId('stacked'),
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system' as const, id: 'provider-fixture' },
});

type Child = DelegationReservation['children'][number];

it('runs six upfront tasks in two unmerged Git stacks with exact cross-repo context, restart and selective freshness (DC-02, DC-12, DC-13, DC-17, DC-30)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wake-stacked-'));
  try {
    const paths = { a: join(home, 'a'), b: join(home, 'b') };
    const repositories = { a: resId('stack-a'), b: resId('stack-b') };
    const heads = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const repo of ['a', 'b'] as const) {
      const path = paths[repo];
      await exec('git', ['init', '-b', 'main', path]);
      await git(path, 'config', 'user.name', 'Agent fixture');
      await git(path, 'config', 'user.email', 'agent@example.test');
      await writeFile(join(path, 'source'), repo);
      await git(path, 'add', '.');
      await git(path, 'commit', '-m', 'source');
      const source = await git(path, 'rev-parse', 'HEAD');
      sources.set(repo, source);
      await git(path, 'switch', '-c', 'prepared');
      for (let i = 1; i <= 3; i++) {
        await writeFile(join(path, repo + i), repo + i);
        await git(path, 'add', '.');
        await git(path, 'commit', '-m', repo + i);
        heads.set(repo + i, await git(path, 'rev-parse', 'HEAD'));
      }
      await git(path, 'switch', 'main');
    }
    const runner = new ScriptedDelegationRunner();
    let mergedConsumerCreated = false;
    const journal = new InMemoryEventJournal({ now: () => new Date() });
    const baseOf = (id: string) =>
      Number(id[1]) > 1 ? id[0] + String(Number(id[1]) - 1) : undefined;
    let children: readonly Child[] = [];
    const childOf = (id: string) => children.find((child) => child.assignmentId === id)!;
    const parentWork = workId('stack-parent');
    const stage = (workspace: string, next: string) => ({
      activity: 'agent',
      with: { prompt: 'Deliver the assignment' },
      execution: { workspace },
      requiresApproval: false,
      on: { done: { then: next } },
    });
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
                  maxConcurrentRuns: 2,
                },
                stages: { delegate: stage('none', 'done') },
              },
              child: {
                stages: {
                  implement: stage('branch', 'verify'),
                  verify: stage('read-only', 'done'),
                },
              },
            },
          },
          integrations: {
            fake: {
              enabled: true,
              events: children.map((child) => ({
                key: `org/${child.assignmentId[0]}#${child.assignmentId[1]}`,
                kind: 'pull-request',
                title: child.assignmentId,
                revision: heads.get(child.assignmentId)!,
                branch: child.workItemId,
                baseBranch:
                  baseOf(child.assignmentId) === undefined
                    ? 'main'
                    : childOf(baseOf(child.assignmentId)!).workItemId,
                baseRevision:
                  baseOf(child.assignmentId) === undefined
                    ? sources.get(child.assignmentId[0]!)!
                    : heads.get(baseOf(child.assignmentId)!)!,
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
          cloneLocator: async (id: string) => (id === repositories.a ? paths.a : paths.b),
        }),
      });
    let root = await open();
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
        workflowInstanceId: workflowInstanceId('stack-parent'),
        workflowName: workflowName('parent'),
        orchestrationGroupId: orchestrationGroupId('stack-parent'),
      },
      context('start'),
    );
    const awaitRuns = async () =>
      vi.waitFor(async () =>
        expect((await root.execution.list()).every((run) => !isActiveRunStatus(run.status))).toBe(
          true,
        ),
      );
    runner.scripts.push(async (request) => {
      const assignments = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((id) => ({
        assignmentId: id,
        objective: 'Implement ' + id,
        criteria: ['Publish exact named outputs'],
        workflowName: workflowName('child'),
        context: [],
        repository: {
          resourceId: repositories[id[0] as 'a' | 'b'],
          sourceRef: 'main',
          pullRequestBase: 'main',
        },
        outputs: [
          { name: 'change', kind: 'change' as const, requireReview: false, requireChecks: false },
          ...(id === 'a1' ? [{ name: 'contract', path: 'contract.md' }] : []),
        ],
        prerequisites: [
          ...(baseOf(id) === undefined
            ? []
            : [
                {
                  assignmentId: baseOf(id)!,
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
      const caller = {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        runId: request.runId,
      };
      const reservation = await root.orchestration.submitDelegation(
        caller,
        { cohortId: 'six', expectedPlanRevision: 0, assignments },
        context('reserve'),
      );
      children = reservation.children;
      expect(
        await root.orchestration.submitDelegation(
          caller,
          { cohortId: 'six', expectedPlanRevision: 0, assignments },
          context('replay'),
        ),
      ).toEqual(reservation);
      return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
    });
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await awaitRuns();
    expect(children).toHaveLength(6);
    expect(await root.orchestration.get(childOf('a2').workflowInstanceId)).toBeNull();
    expect(await root.orchestration.listPendingActivations(childOf('b1').workItemId)).toHaveLength(
      1,
    );
    root = await open();

    const continueParent = async (request: RunnerRequest): Promise<AgentRunnerResult> => {
      if (request.workspacePath !== undefined)
        return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
      const continuation = (await root.orchestration.get(parent.workflowInstanceId))!;
      const mergedPr = (await root.resources.findByExternalKey({
        adapter: 'fake',
        key: 'org/a#1',
      }))!;
      const mergeOriginal = (await root.pullRequests.get(mergedPr.resourceId))!;
      expect(
        await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'six'),
      ).toHaveLength(6);
      expect(mergeOriginal.state).toBe('open');
      const caller = {
        workflowInstanceId: continuation.workflowInstanceId,
        activationId: continuation.pendingActivation!.activationId,
        runId: request.runId,
      };
      const command = {
        cohortId: 'after-merge',
        expectedPlanRevision: 1,
        assignments: [
          {
            assignmentId: 'merged-consumer',
            objective: 'Consume merged work',
            criteria: ['Verified merged source'],
            workflowName: workflowName('child'),
            context: [],
            repository: { resourceId: repositories.a, sourceRef: 'main', pullRequestBase: 'main' },
            outputs: [
              {
                name: 'change',
                kind: 'change' as const,
                requireReview: false,
                requireChecks: false,
              },
            ],
            prerequisites: [
              {
                cohortId: 'six',
                assignmentId: 'a1',
                output: 'change',
                condition: 'merged-change' as const,
              },
            ],
          },
        ],
      };
      // Successful child completion and an open PR do not prove merge. The parent
      // cannot promise to merge only after joining this new consumer.
      await expect(
        root.orchestration.submitDelegation(caller, command, context('not-merged')),
      ).rejects.toMatchObject({ code: 'wait-cycle' });
      // The agent merges; the provider observation is the durable merge evidence.
      await git(paths.a, 'merge', '--ff-only', heads.get('a1')!);
      await root.pullRequests.observe(
        { ...mergeOriginal, state: 'merged' },
        context('provider-merged'),
      );
      await git(paths.a, 'branch', '-D', childOf('a1').workItemId);
      // After joining, the agent can merge both stacks bottom-up and delete their branches.
      for (const id of ['a2', 'a3', 'b1', 'b2', 'b3']) {
        const resource = (await root.resources.findByExternalKey({
          adapter: 'fake',
          key: 'org/' + id[0] + '#' + id[1],
        }))!;
        const observed = (await root.pullRequests.get(resource.resourceId))!;
        await git(id[0] === 'a' ? paths.a : paths.b, 'merge', '--ff-only', heads.get(id)!);
        await git(id[0] === 'a' ? paths.a : paths.b, 'branch', '-D', childOf(id).workItemId);
        await root.pullRequests.observe({ ...observed, state: 'merged' }, context('merge-' + id));
        await root.orchestration.reconcileChildCompletions(context('post-join-' + id));
      }
      const merged = await root.orchestration.submitDelegation(
        caller,
        command,
        context('merged-consumer'),
      );
      const consumer = merged.children[0]!;
      expect(await root.orchestration.get(consumer.workflowInstanceId)).not.toBeNull();
      expect(await root.orchestration.repositoryAssignment(consumer.workItemId)).toMatchObject({
        sourceRevision: heads.get('a3'),
      });
      expect(
        (await root.orchestration.deliveryTree(parentWork))[1]!.children[0]!.consumedInputs!
          .consumed[0]!.reference,
      ).toMatchObject({ resourceId: mergedPr.resourceId, revision: heads.get('a1') });
      mergedConsumerCreated = true;
      return { transport: RunStatus.Succeeded, runner: 'fake', output: '{"status":"DONE"}' };
    };

    runner.scriptFor = (request) =>
      request.workspacePath === undefined ? continueParent : undefined;

    const act = (child: Child) => async (request: RunnerRequest) => {
      const path = request.workspacePath!;
      const id = child.assignmentId;
      const expected = baseOf(id) === undefined ? sources.get(id[0]!)! : heads.get(baseOf(id)!)!;
      expect(await git(path, 'rev-parse', 'HEAD')).toBe(expected);
      await git(path, 'fetch', 'origin', heads.get(id)!);
      await git(path, 'merge', '--ff-only', heads.get(id)!);
      await git(path, 'push', 'origin', 'HEAD:refs/heads/' + child.workItemId);
      if (id === 'a1') {
        const workflow = (await root.orchestration.get(child.workflowInstanceId))!;
        await root.artifacts.stageRevision(
          {
            revisionId: 'api-contract-v1',
            path: 'contract.md',
            bytes: new TextEncoder().encode('Exact contract v1'),
          },
          {
            workItemId: child.workItemId,
            producer: child.workflowInstanceId + '/implement',
            activationId: workflow.pendingActivation!.activationId,
            runId: request.runId,
          },
          context('contract'),
        );
      }
      return {
        transport: RunStatus.Succeeded,
        runner: 'fake',
        output: JSON.stringify({
          status: 'DONE',
          reportedArtifacts: [
            {
              name: 'change',
              kind: 'pull-request',
              externalKey: { adapter: 'fake', key: `org/${id[0]}#${id[1]}` },
            },
          ],
        }),
      };
    };
    const dispatch = async (child: Child, implement: boolean) => {
      runner.scripts.push(
        implement
          ? act(child)
          : async () => ({
              transport: RunStatus.Succeeded,
              runner: 'fake',
              output: '{"status":"DONE"}',
            }),
      );
      await root.advanceOnce({ workItemId: child.workItemId, maxProgress: 1 });
      await awaitRuns();
      const lastRun = (await root.execution.list())
        .filter((run) => run.workflowInstanceId === child.workflowInstanceId)
        .at(-1);
      expect(lastRun?.status, JSON.stringify(lastRun)).toBe('succeeded');
      const view = (await root.orchestration.get(child.workflowInstanceId))!;
      if (!view.acceptedOutcomes.includes(lastRun!.activationId))
        await root.orchestration.acceptOutcome(
          {
            workflowInstanceId: child.workflowInstanceId,
            activationId: lastRun!.activationId,
            outcome: lastRun!.outcome!,
          },
          context('accept-' + lastRun!.runId),
        );
      await root.processorRuntime.catchUp('register-stack-pr');
      const resource = await root.resources.findByExternalKey({
        adapter: 'fake',
        key: `org/${child.assignmentId[0]}#${child.assignmentId[1]}`,
      });
      expect(resource).not.toBeNull();
      if ((await root.pullRequests.get(resource!.resourceId))?.state !== 'merged')
        await root.pullRequests.observe(
          {
            resourceId: resource!.resourceId,
            workItemId: child.workItemId,
            state: 'open',
            headRevision: heads.get(child.assignmentId)!,
            baseRevision:
              baseOf(child.assignmentId) === undefined
                ? sources.get(child.assignmentId[0]!)!
                : heads.get(baseOf(child.assignmentId)!)!,
            checks: 'passing',
          },
          context('observe-' + child.assignmentId),
        );
      await root.orchestration.reconcileChildCompletions(
        context('reconcile-' + child.assignmentId),
      );
    };
    // b1 remains independent even while all a descendants are queued.
    await dispatch(childOf('b1'), true);
    await dispatch(childOf('a1'), true);
    expect((await root.orchestration.get(childOf('a1').workflowInstanceId))!.status).toBe('active');
    expect(await root.orchestration.get(childOf('a2').workflowInstanceId)).not.toBeNull();
    await dispatch(childOf('a2'), true);
    root = await open();
    await dispatch(childOf('b2'), true);
    await dispatch(childOf('a3'), true);
    await dispatch(childOf('b3'), true);
    const tree = (await root.orchestration.deliveryTree(parentWork))[0]!;
    const receipt = tree.children.find((child) => child.assignmentId === 'b3')!.consumedInputs!;
    expect(receipt.consumed.map((entry) => entry.reference)).toContainEqual({
      workItemId: childOf('a1').workItemId,
      revisionId: 'api-contract-v1',
    });
    expect(
      await new ArtifactContextService(root.journal, root.artifacts).childReferences(
        parentWork,
        childOf('b3').workItemId,
      ),
    ).toContainEqual({ workItemId: childOf('a1').workItemId, revisionId: 'api-contract-v1' });
    expect(receipt.repository).toMatchObject({
      resourceId: repositories.b,
      sourceRevision: heads.get('b2'),
      pullRequestBase: childOf('b2').workItemId,
    });
    // Move only A's base branch. No repair is selected and unrelated B review remains eligible.
    await git(paths.a, 'update-ref', 'refs/heads/' + childOf('a1').workItemId, heads.get('a2')!);
    root = await open();
    expect(await root.orchestration.listPendingActivations(childOf('a2').workItemId)).toHaveLength(
      0,
    );
    expect(await root.orchestration.listPendingActivations(childOf('a3').workItemId)).toHaveLength(
      0,
    );
    expect(
      (await root.orchestration.deliveryTree(parentWork))[0]!.children.find(
        (child) => child.assignmentId === 'b2',
      )!.prerequisiteBlocker,
    ).toBeUndefined();
    const detail = await (
      await createSurfaceApplications(root)
    ).api.work.detail(toWorkItemKey(parentWork));
    expect(
      detail!.data.delegation!.children.find(
        (child) => child.workItemKey === toWorkItemKey(childOf('a2').workItemId),
      )!.blockReason,
    ).toContain('branch moved');
    // DC-23: the blocked stacked child names its prerequisite for navigation and why it waits,
    // while an unaffected sibling with satisfied prerequisites reports no blocker.
    const rows = new Map(detail!.data.delegation!.children.map((row) => [row.workItemKey, row]));
    const blockedRow = rows.get(toWorkItemKey(childOf('a2').workItemId))!;
    expect(blockedRow.prerequisites).toContain(toWorkItemKey(childOf('a1').workItemId));
    expect(blockedRow.prerequisiteBlocker).toContain('branch moved');
    expect(rows.get(toWorkItemKey(childOf('b2').workItemId))!.prerequisiteBlocker).toBeUndefined();
    // Preserve historical receipts; returning to the exact source is an explicit agent operation.
    await git(paths.a, 'update-ref', 'refs/heads/' + childOf('a1').workItemId, heads.get('a1')!);
    const upstreamPr = (await root.resources.findByExternalKey({
      adapter: 'fake',
      key: 'org/a#1',
    }))!;
    const original = (await root.pullRequests.get(upstreamPr.resourceId))!;
    await root.pullRequests.observe(
      { ...original, baseRevision: heads.get('a1')! },
      context('base-moved'),
    );
    root = await open();
    const movedBase = (await root.orchestration.deliveryTree(parentWork))[0]!.children;
    expect(
      movedBase.find((child) => child.assignmentId === 'a2')!.prerequisiteBlocker,
    ).toBeUndefined();
    expect(
      movedBase.find((child) => child.assignmentId === 'b3')!.prerequisiteBlocker,
    ).toBeUndefined();
    await root.pullRequests.observe(original, context('base-restored'));
    for (const child of children) {
      if ((await root.orchestration.get(child.workflowInstanceId))!.status !== 'completed')
        await dispatch(child, false);
    }
    await root.orchestration.reconcileChildCompletions(context('join'));
    expect(
      await root.orchestration.joinedDelegationResults(parent.workflowInstanceId, 'six'),
    ).toHaveLength(6);
    for (const child of children) {
      const resource = await root.resources.findByExternalKey({
        adapter: 'fake',
        key: `org/${child.assignmentId[0]}#${child.assignmentId[1]}`,
      });
      expect((await root.pullRequests.get(resource!.resourceId))!.state).toBe(
        mergedConsumerCreated ? 'merged' : 'open',
      );
    }
    await root.advanceOnce({ workItemId: parentWork, maxProgress: 1 });
    await awaitRuns();
    const continuedRun = (await root.execution.list())
      .filter((run) => run.workflowInstanceId === parent.workflowInstanceId)
      .at(-1)!;
    expect(continuedRun.status, JSON.stringify(continuedRun.failure)).toBe('succeeded');
    expect(await root.orchestration.deliveryTree(parentWork)).toHaveLength(2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

import { correlationId } from '@atolis-hq/eventing';
import { InMemoryCheckpointStore, InMemoryProjectionStore } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
  type DelegatedAssignment,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { FaultInjectingJournal } from '../../support/fault-injecting-journal.js';
import { workId } from '../../support/identities.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('delegation-composition'),
  occurredAt: '2026-10-18T12:00:00.000Z',
  actor: { kind: 'system' as const, id: 'test' },
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wake-delegation-'));
  homes.push(home);
  const journal = new FaultInjectingJournal({ now: () => new Date() });
  const agent = {
    activity: 'agent',
    with: { prompt: 'Publish findings' },
    execution: { workspace: 'none' },
    requiresApproval: false,
    on: { done: { then: 'done' } },
  };
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
          stages: { seed: { ...agent, on: { done: { then: 'delegate' } } }, delegate: agent },
        },
        child: { stages: { work: agent } },
      },
    },
  });
  const restart = () =>
    createCompositionRoot(home, {
      config,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });
  return { root: await restart(), restart, journal };
}

async function start(root: CompositionRoot, id: string, name = 'parent') {
  const workItemId = workId(id);
  await root.work.create({ workItemId, objective: id }, context('create-' + id));
  return root.orchestration.start(
    {
      workItemId,
      workflowInstanceId: workflowInstanceId(id),
      workflowName: workflowName(name),
      orchestrationGroupId: orchestrationGroupId(id),
    },
    context('start-' + id),
  );
}

async function publish(root: CompositionRoot, view: WorkflowInstanceView, revisionId: string) {
  await root.artifacts.stageRevision(
    { revisionId, path: 'findings.md', bytes: new TextEncoder().encode('findings') },
    {
      workItemId: view.workItemId,
      producer: view.workflowInstanceId + '/work',
      runId: 'run-' + revisionId,
      activationId: view.pendingActivation!.activationId,
    },
    context('publish-' + revisionId),
  );
  return { workItemId: view.workItemId, revisionId };
}

async function complete(root: CompositionRoot, view: WorkflowInstanceView) {
  return root.orchestration.acceptOutcome(
    {
      workflowInstanceId: view.workflowInstanceId,
      activationId: view.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-' + view.pendingActivation!.activationId),
  );
}

function assignment(
  fingerprint: string,
  references: DelegatedAssignment['context'],
): DelegatedAssignment {
  return {
    assignmentId: 'child',
    objective: 'Investigate',
    criteria: ['Findings'],
    workflowName: workflowName('child'),
    workflowFingerprint: fingerprint,
    context: references,
    outputs: [{ name: 'findings', path: 'findings.md' }],
  };
}

it('production composition rejects unrelated accepted and draft context, accepts exact ancestor context, and recovers joins', async () => {
  const f = await fixture();
  const seed = await start(f.root, 'parent');
  const accepted = await publish(f.root, seed, 'parent-seed');
  const parent = await complete(f.root, seed);
  const outsider = await start(f.root, 'outsider', 'child');
  const unrelated = await publish(f.root, outsider, 'unrelated');
  await complete(f.root, outsider);
  const fingerprint = outsider.workflowDefinitionFingerprint!;
  const caller = {
    workflowInstanceId: parent.workflowInstanceId,
    activationId: parent.pendingActivation!.activationId,
    runId: 'parent-run',
  };
  await expect(
    f.root.orchestration.delegatedWork.reserve(
      caller,
      'bad',
      [assignment(fingerprint, [unrelated])],
      context('bad'),
    ),
  ).rejects.toThrow('outside the parent hierarchy');
  const draft = await publish(f.root, parent, 'draft-parent');
  await expect(
    f.root.orchestration.delegatedWork.reserve(
      caller,
      'draft',
      [assignment(fingerprint, [draft])],
      context('draft'),
    ),
  ).rejects.toThrow('accepted artifact revisions');
  const top = await f.root.orchestration.delegatedWork.reserve(
    caller,
    'top',
    [assignment(fingerprint, [accepted])],
    context('top'),
    { maxDepth: 2, maxDescendants: 3 },
  );
  const child = (await f.root.orchestration.get(top.children[0]!.workflowInstanceId))!;
  const nestedCaller = {
    workflowInstanceId: child.workflowInstanceId,
    activationId: child.pendingActivation!.activationId,
    runId: 'nested-run',
  };
  const nested = await f.root.orchestration.delegatedWork.reserve(
    nestedCaller,
    'nested',
    [assignment(fingerprint, [accepted])],
    context('nested'),
  );
  const root = await f.restart();
  const grandchild = (await root.orchestration.get(nested.children[0]!.workflowInstanceId))!;
  await publish(root, grandchild, 'grandchild-result');
  await complete(root, grandchild);
  const resumedChild = (await root.orchestration.get(child.workflowInstanceId))!;
  await publish(root, resumedChild, 'child-result');
  await complete(root, resumedChild);
  const restarted = await f.restart();
  await restarted.orchestration.reconcileChildCompletions(context('restart'));
  expect(
    await restarted.orchestration.delegatedWork.results(parent.workflowInstanceId, 'top'),
  ).toMatchObject([
    {
      childWorkItemId: child.workItemId,
      outputs: [{ name: 'findings', reference: { revisionId: 'child-result' } }],
    },
  ]);
  const resumedParent = (await restarted.orchestration.get(parent.workflowInstanceId))!;
  expect(resumedParent.pendingActivation!.input).toEqual(parent.pendingActivation!.input);
  // Accepted child findings are usable in a later cohort, with a new immutable grant.
  const next = await restarted.orchestration.delegatedWork.reserve(
    { ...caller, activationId: resumedParent.pendingActivation!.activationId, runId: 'later-run' },
    'later',
    [assignment(fingerprint, [{ workItemId: child.workItemId, revisionId: 'child-result' }])],
    context('later'),
  );
  expect(next.children[0]!.grantId).not.toBe(top.children[0]!.grantId);
});

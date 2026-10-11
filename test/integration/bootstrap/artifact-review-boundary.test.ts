import { correlationId } from '@atolis-hq/eventing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { artifactPath, FileArtifactMcpSessionStore } from '../../../src/artifacts/index.js';
import {
  createArtifactMcpProvisioner,
  createArtifactMcpServerForSession,
} from '../../../src/bootstrap/artifact-mcp.js';
import { createCompositionRoot } from '../../../src/bootstrap/index.js';
import {
  createWatchReactor,
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it('publishes refine artifacts while its review gate waits and lets the review child read the canonical plan without modifying it', async () => {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-artifact-review-'));
  const client = new Client({ name: 'child-review-test', version: '1.0.0' });
  try {
    await writeFile(
      join(wakeRoot, 'config.yaml'),
      `schemaVersion: 1
execution:
  agentRunners: { fake: { kind: fake } }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
orchestration:
  default: dark-factory
  workflows:
    dark-factory:
      stages:
        refine:
          activity: agent
          with: { prompt: plan }
          execution: { workspace: none }
          on: { done: { then: implement, watchGates: [plan-review] } }
        implement:
          activity: agent
          with: { prompt: implement }
          execution: { workspace: none }
          on: { done: { then: done } }
      watches:
        - id: plan-review
          while: { stages: [refine], statuses: [waiting] }
          on: { events: [orchestration.signal-wait-started] }
          workflow: plan-review
          maxPerGroup: 1
    plan-review:
      stages:
        review:
          activity: agent
          with: { prompt: review }
          execution: { workspace: none }
          on: { done: { then: done } }
`,
    );
    const root = await createCompositionRoot(wakeRoot);
    const workItemId = workId('artifact-review');
    const now = () => new Date().toISOString();
    const context = {
      commandId: 'create',
      correlationId: correlationId('artifact-review'),
      occurredAt: now(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    await root.work.create({ workItemId, objective: 'review a plan' }, context);
    const parent = await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('artifact-review-parent'),
        workItemId,
        workflowName: workflowName('dark-factory'),
        orchestrationGroupId: orchestrationGroupId('artifact-review-group'),
      },
      { ...context, commandId: 'start' },
    );
    const producer = `${parent.workflowInstanceId}/refine`;
    await root.artifacts.stageRevision(
      {
        revisionId: 'plan-revision',
        path: artifactPath('plan.md'),
        bytes: new TextEncoder().encode('# Canonical plan'),
      },
      {
        workItemId,
        producer,
        runId: 'refine-run',
        activationId: parent.pendingActivation!.activationId,
      },
      { ...context, commandId: 'plan' },
    );
    const waiting = await root.orchestration.acceptOutcome(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        outcome: { kind: 'done' },
      },
      { ...context, commandId: 'accepted' },
    );
    expect(waiting.status).toBe('waiting');
    expect(waiting.acceptedOutcomes).toContain(parent.pendingActivation!.activationId);
    const published = await root.artifacts.latestPublished(workItemId, async (id) =>
      waiting.acceptedOutcomes.includes(id as never),
    );
    expect(published).toMatchObject([{ revisionId: 'plan-revision', producer }]);
    const waitEvent = (await root.journal.readAll(0)).find(
      (event) => event.event.eventType === OrchestrationEventType.SignalWaitStarted,
    );
    if (waitEvent === undefined) throw new Error('Parent did not enter the review gate');
    await createWatchReactor(root.orchestration).react(waitEvent, {
      ...context,
      commandId: 'watch',
    });
    const child = (await root.orchestration.listAll()).find(
      (candidate) => candidate.parentWorkflowInstanceId === parent.workflowInstanceId,
    );
    if (child === undefined) throw new Error('Watch did not start a review child');
    await root.artifacts.stageRevision(
      {
        revisionId: 'unaccepted-plan',
        path: artifactPath('plan.md'),
        bytes: new TextEncoder().encode('# Unaccepted change'),
      },
      { workItemId, producer, runId: 'other-run', activationId: 'unaccepted-activation' },
      { ...context, commandId: 'unaccepted' },
    );
    const otherWorkItemId = workId('other-artifact-review');
    await root.work.create(
      { workItemId: otherWorkItemId, objective: 'unrelated work' },
      { ...context, commandId: 'other-work' },
    );
    await root.artifacts.stageRevision(
      {
        revisionId: 'foreign-plan',
        path: artifactPath('plan.md'),
        bytes: new TextEncoder().encode('# Foreign plan'),
      },
      {
        workItemId: otherWorkItemId,
        producer,
        runId: 'foreign-run',
        activationId: parent.pendingActivation!.activationId,
      },
      { ...context, commandId: 'foreign' },
    );
    const sessions = new FileArtifactMcpSessionStore(root.paths.artifactsRoot);
    const provision = createArtifactMcpProvisioner({
      artifacts: root.artifacts,
      orchestration: root.orchestration,
      sessions,
      wakeRoot,
      now,
      nextId: () => 'unused',
    });
    const capability = await provision({
      runId: 'review-run',
      activation: child.pendingActivation!,
      context: {
        workItemId,
        workflowInstanceId: child.workflowInstanceId,
        orchestrationGroupId: child.orchestrationGroupId,
        resources: [],
      },
    });
    const configured = capability.servers[0]!;
    expect(capability.prompt).toContain('plan-revision');
    expect(capability.prompt).not.toContain('unaccepted-plan');
    expect(capability.prompt).not.toContain('foreign-plan');
    const server = await createArtifactMcpServerForSession(
      root,
      sessions,
      configured.args![3]!,
      configured.env!.WAKE_MCP_TOKEN!,
      { now, nextId: () => 'child-revision' },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    expect(await client.callTool({ name: 'wake_artifacts_list' })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('plan-revision') }],
    });
    expect(
      await client.callTool({
        name: 'wake_artifacts_read',
        arguments: { revisionId: 'plan-revision' },
      }),
    ).toMatchObject({ content: [{ type: 'text', text: '# Canonical plan' }] });
    expect(
      (
        await client.callTool({
          name: 'wake_artifacts_patch',
          arguments: { revisionId: 'plan-revision', find: 'Canonical', replace: 'Changed' },
        })
      ).isError,
    ).toBe(true);
    expect(new TextDecoder().decode(await root.artifacts.read(published[0]!.location!))).toBe(
      '# Canonical plan',
    );
    for (const revisionId of ['unaccepted-plan', 'foreign-plan']) {
      expect(
        (await client.callTool({ name: 'wake_artifacts_read', arguments: { revisionId } })).isError,
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: 'wake_artifacts_write',
          arguments: { path: 'plan.md', content: '# Review notes' },
        })
      ).isError,
    ).not.toBe(true);
    const revisions = (await root.artifacts.get(workItemId))!.revisions;
    expect(revisions.find((revision) => revision.revisionId === 'child-revision')?.producer).toBe(
      `${child.workflowInstanceId}/review`,
    );
    expect(new TextDecoder().decode(await root.artifacts.read(published[0]!.location!))).toBe(
      '# Canonical plan',
    );
    await capability.release();
  } finally {
    await client.close();
    await rm(wakeRoot, { recursive: true, force: true });
  }
}, 15_000);

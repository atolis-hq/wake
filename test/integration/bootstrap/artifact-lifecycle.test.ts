import { correlationId } from '@atolis-hq/eventing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileArtifactMcpSessionStore } from '../../../src/artifacts/index.js';
import { createArtifactMcpProvisioner } from '../../../src/bootstrap/artifact-mcp.js';
import { createCompositionRoot, createSurfaceApplications } from '../../../src/bootstrap/index.js';
import { claudeCommandArgs } from '../../../src/execution/infrastructure/runners/claude.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { createApiDispatcher } from '../../../src/surfaces/api/routes/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { workId } from '../../support/identities.js';

it('stages over the production stdio MCP surface, publishes on accepted outcome, and revokes access', async () => {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-artifact-lifecycle-'));
  const client = new Client({ name: 'artifact-test', version: '1.0.0' });
  try {
    await writeFile(
      join(wakeRoot, 'config.yaml'),
      `schemaVersion: 1
execution:
  agentRunners: { fake: { kind: fake } }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
orchestration:
  workflows:
    default:
      stages:
        produce:
          activity: agent
          with: { prompt: generate an artifact }
          execution: { workspace: none }
          on: { done: { then: done } }
`,
    );
    let root = await createCompositionRoot(wakeRoot);
    const now = () => new Date().toISOString();
    const workItemId = workId('artifact-lifecycle');
    const context = {
      commandId: 'artifact-lifecycle',
      correlationId: correlationId('artifact-lifecycle'),
      occurredAt: now(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    await root.work.create({ workItemId, objective: 'produce an artifact' }, context);
    const workflow = await root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('artifact-lifecycle-workflow'),
        workItemId,
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId('artifact-lifecycle-group'),
      },
      { ...context, commandId: 'start' },
    );
    const provision = createArtifactMcpProvisioner({
      artifacts: root.artifacts,
      orchestration: root.orchestration,
      sessions: new FileArtifactMcpSessionStore(root.paths.artifactsRoot),
      wakeRoot,
      now,
      nextId: () => 'unused',
    });
    const capability = await provision({
      runId: 'artifact-lifecycle-run',
      activation: workflow.pendingActivation!,
      context: {
        workItemId,
        workflowInstanceId: workflow.workflowInstanceId,
        orchestrationGroupId: workflow.orchestrationGroupId,
        resources: [],
      },
    });
    const args = claudeCommandArgs({
      runId: 'artifact-lifecycle-run',
      prompt: capability.prompt ?? '',
      allowedTools: ['Read'],
      mcpServers: [...capability.servers, { name: 'other', command: 'other' }],
    });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read mcp__wake');
    expect(capability.prompt).toContain('canonical plan');
    const server = capability.servers[0]!;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', resolve('src/main.ts'), ...server.args!],
        env: {
          ...process.env,
          ...server.env,
          TSX_TSCONFIG_PATH: resolve('tsconfig.source.json'),
        } as Record<string, string>,
        stderr: 'pipe',
      }),
    );
    const advertised = await client.listTools();
    expect(advertised.tools).toHaveLength(5);
    for (const tool of advertised.tools) expect(tool.name).toMatch(/^wake_artifacts_[a-z]+$/);
    const write = await client.callTool({
      name: 'wake_artifacts_write',
      arguments: { path: 'plan.md', content: '# Plan', mediaType: 'text/markdown' },
    });
    expect(write.isError).not.toBe(true);
    root = await createCompositionRoot(wakeRoot);
    const staged = await root.artifacts.get(workItemId);
    expect(staged?.revisions).toHaveLength(1);
    const revisionId = staged!.revisions[0]!.revisionId;
    const manifest = await client.callTool({ name: 'wake_artifacts_list' });
    expect(manifest).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(revisionId) }],
    });
    const read = await client.callTool({ name: 'wake_artifacts_read', arguments: { revisionId } });
    expect(read).toMatchObject({ content: [{ type: 'text', text: '# Plan' }] });
    await root.projectionSubscriptions.catchUpOnce();
    const applications = await createSurfaceApplications(root);
    expect((await applications.api.work.detail(toWorkItemKey(workItemId)))?.data.artifacts).toEqual(
      [],
    );
    await root.orchestration.acceptOutcome(
      {
        workflowInstanceId: workflow.workflowInstanceId,
        activationId: workflow.pendingActivation!.activationId,
        outcome: { kind: 'done' },
      },
      { ...context, commandId: 'accepted' },
    );
    const detail = await applications.api.work.detail(toWorkItemKey(workItemId));
    expect(detail?.data.artifacts).toMatchObject([{ revisionId, path: 'plan.md' }]);
    const download = await createApiDispatcher(applications.api).dispatch(
      'GET',
      detail!.data.artifacts[0]!.href,
      undefined,
    );
    if (download === undefined) throw new Error('Artifact download route was not found');
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(download.body as Uint8Array)).toBe('# Plan');
    await capability.release();
    const revoked = await client.callTool({ name: 'wake_artifacts_list' });
    expect(revoked.isError).toBe(true);
  } finally {
    await client.close();
    await rm(wakeRoot, { recursive: true, force: true });
  }
}, 15_000);

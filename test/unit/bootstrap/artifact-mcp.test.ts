import { InMemoryProcessorStateStore } from '@atolis-hq/eventing/memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { FileArtifactMcpSessionStore } from '../../../src/artifacts/index.js';
import {
  createArtifactMcpProvisioner,
  createArtifactMcpServerForSession,
} from '../../../src/bootstrap/artifact-mcp.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../../../src/execution/index.js';
import { integrationsConfigSchema } from '../../../src/integrations/index.js';
import type { OrchestrationService } from '../../../src/orchestration/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('artifact MCP provisioning', () => {
  it('injects a scoped Wake command, manifest, and revocable run credential', async () => {
    const sessions = new FileArtifactMcpSessionStore(
      await directory(),
      () => '2026-09-19T12:00:00.000Z',
    );
    const provision = createArtifactMcpProvisioner({
      artifacts: {
        get: async () => ({
          revisions: [{ producer: 'workflow-1/refine' }, { producer: 'review-child/review' }],
        }),
        visibleTo: async () => [],
      } as never,
      orchestration: orchestration() as never,
      sessions,
      wakeRoot: '/wake',
      now: () => '2026-09-19T12:00:00.000Z',
      nextId: () => 'artifact-1',
    });
    const capability = await provision({
      runId: 'run-1',
      activation,
      context,
    });

    expect(capability.servers).toEqual([
      expect.objectContaining({
        name: 'wake',
        command: 'wake',
        args: ['mcp', 'serve', '--session', expect.any(String), '--wake-root', '/wake'],
        env: { WAKE_MCP_TOKEN: expect.any(String) },
      }),
    ]);
    expect(capability.prompt).toContain('Wake artifacts');
    const server = capability.servers[0]!;
    const sessionPath = server.args![3]!;
    const token = server.env?.WAKE_MCP_TOKEN;
    if (token === undefined) throw new Error('Expected a Wake MCP token');
    await expect(sessions.read(sessionPath, token)).resolves.toMatchObject({
      producer: 'workflow-1/implement',
      readableProducers: expect.arrayContaining([
        'workflow-1/refine',
        'workflow-1/implement',
        'review-child/review',
      ]),
    });
    await capability.release();
    await expect(sessions.read(sessionPath, token)).rejects.toThrow();
  });
});

const activation: ExecutionActivation = {
  activationId: activationId('activation-1'),
  ordinal: 1,
  activity: activityName('agent'),
  stage: 'implement',
  input: { prompt: 'Implement' },
  execution: { workspace: 'none' },
};

const context: ExecutionAttemptContext = {
  workItemId: workId('artifact-mcp'),
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  resources: [],
};

function orchestration(): Pick<OrchestrationService, 'listAll'> {
  return { listAll: async () => [] };
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-mcp-'));
  directories.push(path);
  return path;
}

it.each([false, true])(
  'registers oversight tools only with both stage tools opted in (%s)',
  async (optIn) => {
    const sessions = new FileArtifactMcpSessionStore(
      await directory(),
      () => '2026-09-19T12:00:00.000Z',
    );
    const issued = await sessions.issue({
      workItemId: context.workItemId,
      producer: 'workflow-1/implement',
      runId: 'run-1',
      activationId: activation.activationId,
      readableProducers: [],
      expiresAt: '2026-09-19T14:00:00.000Z',
    });
    const pendingActivation = {
      ...activation,
      input: {
        prompt: 'text',
        vars: { focus: 'prompt text' },
        ...(optIn
          ? { allowedTools: ['mcp__wake__wake_github_read', 'mcp__wake__wake_github_assign'] }
          : {}),
      },
    };
    const server = await createArtifactMcpServerForSession(
      {
        artifacts: {} as never,
        orchestration: {
          listAll: async () => [
            {
              workItemId: context.workItemId,
              workflowInstanceId: context.workflowInstanceId,
              pendingActivation,
            },
          ],
        } as never,
        config: {
          integrations: integrationsConfigSchema.parse({
            github: { enabled: true, repositories: [{ owner: 'configured', repo: 'repo' }] },
          }),
        },
        processorState: new InMemoryProcessorStateStore(),
        paths: { locksRoot: await directory() },
      },
      sessions,
      issued.path,
      issued.token,
      { now: () => '2026-09-19T12:00:00.000Z', nextId: () => 'revision-1' },
    );
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(ct), server.connect(st)]);
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name === 'wake_github_read')).toBe(optIn);
      expect(tools.some((tool) => tool.name === 'wake_github_assign')).toBe(optIn);
      if (optIn)
        expect(tools.find((tool) => tool.name === 'wake_github_read')?.description).toContain(
          'configured/repo',
        );
    } finally {
      await client.close();
      await server.close();
    }
  },
);

it.each([undefined, { github: { enabled: false } }])(
  'rejects opted-in provisioning with unavailable integration',
  async (integrations) => {
    const provision = createArtifactMcpProvisioner({
      ...(integrations === undefined ? {} : { integrations }),
      artifacts: {} as never,
      orchestration: orchestration() as never,
      sessions: new FileArtifactMcpSessionStore(await directory()),
      wakeRoot: '/wake',
      now: () => '2026-09-19T12:00:00.000Z',
      nextId: () => 'artifact-1',
    });
    await expect(
      provision({
        runId: 'run-1',
        context,
        activation: {
          ...activation,
          input: {
            prompt: 'text',
            allowedTools: ['mcp__wake__wake_github_read', 'mcp__wake__wake_github_assign'],
          },
        },
      }),
    ).rejects.toThrow('require enabled integrations.github');
  },
);

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
import { withDelegatedGrants } from '../../../src/bootstrap/delegated-artifact-context.js';
import type { ExecutionActivation, ExecutionAttemptContext } from '../../../src/execution/index.js';
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

  it('lets a delegated child read the artifacts its parent granted to it', async () => {
    const sessions = new FileArtifactMcpSessionStore(
      await directory(),
      () => '2026-09-19T12:00:00.000Z',
    );
    const grant = { workItemId: workId('parent'), revisionId: 'brief-1' };
    const scopes: { readonly sharedReferences?: readonly unknown[] }[] = [];
    const provision = createArtifactMcpProvisioner({
      artifacts: {
        get: async () => ({ revisions: [] }),
        visibleTo: async (scope: { readonly sharedReferences?: readonly unknown[] }) => {
          scopes.push(scope);
          return [];
        },
      } as never,
      orchestration: orchestration() as never,
      sessions,
      wakeRoot: '/wake',
      now: () => '2026-09-19T12:00:00.000Z',
      nextId: () => 'artifact-1',
      sharedContext: withDelegatedGrants(
        async () => ({}),
        async () => [grant],
      ),
    });
    const capability = await provision({ runId: 'run-1', activation, context });

    expect(scopes[0]?.sharedReferences).toEqual([grant]);
    const server = capability.servers[0]!;
    await expect(
      sessions.read(server.args![3]!, server.env!.WAKE_MCP_TOKEN!),
    ).resolves.toMatchObject({ sharedReferences: [grant] });
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

function orchestration(
  attention: Awaited<ReturnType<OrchestrationService['openDelegationAttention']>> = null,
): Pick<OrchestrationService, 'listAll' | 'openDelegationAttention'> {
  return { listAll: async () => [], openDelegationAttention: async () => attention };
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-mcp-'));
  directories.push(path);
  return path;
}

it('tells the delegating agent that an attention activation is an assessment', async () => {
  const provision = createArtifactMcpProvisioner({
    artifacts: { get: async () => ({ revisions: [] }), visibleTo: async () => [] } as never,
    orchestration: orchestration({
      cohortId: 'cohort-1',
      attentionKey: 'cohort-1@1:grant-1:failed',
      activationId: 'act' as never,
      revision: 1,
      blockers: [
        {
          blockerId: 'grant-1:failed',
          childWorkItemId: 'work-2' as never,
          kind: 'failed',
          reason: 'Child failed',
        },
      ],
      responses: [],
    }) as never,
    sessions: new FileArtifactMcpSessionStore(await directory(), () => '2026-09-19T12:00:00.000Z'),
    wakeRoot: '/wake',
    now: () => '2026-09-19T12:00:00.000Z',
    nextId: () => 'artifact-1',
  });
  const capability = await provision({ runId: 'run-1', activation, context });
  expect(capability.prompt).toContain('Delegation attention');
  expect(capability.prompt).toContain('grant-1:failed');
  expect(capability.prompt).toContain('not a request to delegate again');
});

it('exposes only Wake-owned tools without provider configuration or recovery storage', async () => {
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
  const server = await createArtifactMcpServerForSession(
    { artifacts: {} as never, orchestration: orchestration() as never },
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
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'wake_artifacts_delete',
      'wake_artifacts_list',
      'wake_artifacts_patch',
      'wake_artifacts_read',
      'wake_artifacts_write',
      'wake_context_instructions_read',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

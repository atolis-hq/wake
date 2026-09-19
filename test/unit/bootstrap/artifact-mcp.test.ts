import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { FileArtifactMcpSessionStore } from '../../../src/artifacts/index.js';
import { createArtifactMcpProvisioner } from '../../../src/bootstrap/artifact-mcp.js';
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
      artifacts: { visibleTo: async () => [] } as never,
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
      readableProducers: expect.arrayContaining(['workflow-1/refine', 'workflow-1/implement']),
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
  input: {},
  execution: { workspace: 'none' },
};

const context: ExecutionAttemptContext = {
  workItemId: workId('artifact-mcp'),
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  resources: [],
};

function orchestration(): Pick<OrchestrationService, 'get' | 'definitionFor' | 'listForWorkItem'> {
  return {
    get: async () => ({ workflowName: 'default' }) as never,
    definitionFor: async () =>
      ({
        stages: {
          refine: {
            on: {
              done: {
                target: { kind: 'stage', stage: 'implement' },
                reentryTarget: { kind: 'stage', stage: 'implement' },
              },
            },
          },
          implement: { on: {} },
        },
      }) as never,
    listForWorkItem: async () => [],
  };
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-mcp-'));
  directories.push(path);
  return path;
}

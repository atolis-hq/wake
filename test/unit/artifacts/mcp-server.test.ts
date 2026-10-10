import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileArtifactStore,
  createArtifactMcpServer,
  createArtifactService,
} from '../../../src/artifacts/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];
const context = {
  commandId: 'mcp-command',
  correlationId: correlationId('mcp-test'),
  actor: { kind: 'system' as const, id: 'test' },
  occurredAt: '2026-09-19T12:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('artifact MCP server', () => {
  it('exposes only artifact tools and attributes writes to its bound activation', async () => {
    const artifacts = createArtifactService(
      new InMemoryEventJournal(new FakeClock()),
      new FileArtifactStore(await directory()),
      { maxWriteBytes: 100, maxWorkItemBytes: 200 },
    );
    const workItemId = workId('mcp');
    const server = createArtifactMcpServer(artifacts, {
      workItemId,
      producer: 'workflow/refine',
      runId: 'run-1',
      activationId: 'activation-1',
      readableProducers: new Set(['workflow/refine']),
      nextRevisionId: (() => {
        let count = 0;
        return () => `revision-${++count}`;
      })(),
      commandContext: () => context,
      acceptedActivation: async () => false,
      assertActive: async () => undefined,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'wake.artifacts.list' }),
        expect.objectContaining({ name: 'wake.artifacts.read' }),
        expect.objectContaining({ name: 'wake.artifacts.write' }),
        expect.objectContaining({ name: 'wake.artifacts.patch' }),
        expect.objectContaining({ name: 'wake.artifacts.delete' }),
      ]),
    });
    await client.callTool({
      name: 'wake.artifacts.write',
      arguments: { path: 'spec.md', content: '# Spec' },
    });
    await expect(
      client.callTool({
        name: 'wake.artifacts.read',
        arguments: { revisionId: 'revision-1', encoding: 'utf8' },
      }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ text: '# Spec' })] });
    await client.callTool({
      name: 'wake.artifacts.write',
      arguments: { path: 'diagram.bin', content: 'AAEC', encoding: 'base64' },
    });
    await expect(
      client.callTool({
        name: 'wake.artifacts.read',
        arguments: { revisionId: 'revision-2', encoding: 'base64' },
      }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ text: 'AAEC' })] });
    await expect(artifacts.get(workItemId)).resolves.toMatchObject({
      revisions: expect.arrayContaining([
        expect.objectContaining({ producer: 'workflow/refine', activationId: 'activation-1' }),
      ]),
    });
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-mcp-'));
  directories.push(path);
  return path;
}

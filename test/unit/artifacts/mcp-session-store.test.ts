import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactMcpSessionStore } from '../../../src/artifacts/index.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('FileArtifactMcpSessionStore', () => {
  it('issues an opaque, token-protected run descriptor outside the workspace', async () => {
    const store = new FileArtifactMcpSessionStore(
      await directory(),
      () => '2026-09-19T12:00:00.000Z',
    );
    const issued = await store.issue({
      workItemId: workId('mcp-session'),
      producer: 'workflow/refine',
      runId: 'run-1',
      activationId: 'activation-1',
      readableProducers: ['workflow/refine'],
      expiresAt: '2026-09-19T13:00:00.000Z',
    });

    await expect(store.read(issued.path, issued.token)).resolves.toMatchObject({
      producer: 'workflow/refine',
      activationId: 'activation-1',
    });
    await expect(store.read(issued.path, 'wrong')).rejects.toThrow('Invalid artifact MCP session');
    await store.revoke(issued.path);
    await expect(store.read(issued.path, issued.token)).rejects.toThrow();
  });

  it('rejects expired credentials', async () => {
    const store = new FileArtifactMcpSessionStore(
      await directory(),
      () => '2026-09-19T12:00:00.000Z',
    );
    const issued = await store.issue({
      workItemId: workId('expired-mcp-session'),
      producer: 'workflow/refine',
      runId: 'run-1',
      activationId: 'activation-1',
      readableProducers: ['workflow/refine'],
      expiresAt: '2026-09-19T11:59:59.000Z',
    });
    await expect(store.read(issued.path, issued.token)).rejects.toThrow(
      'Invalid artifact MCP session',
    );
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-mcp-session-'));
  directories.push(path);
  return path;
}

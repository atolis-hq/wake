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
    const store = new FileArtifactMcpSessionStore(await directory());
    const issued = await store.issue({
      workItemId: workId('mcp-session'),
      producer: 'workflow/refine',
      runId: 'run-1',
      activationId: 'activation-1',
      readableProducers: ['workflow/refine'],
    });

    await expect(store.read(issued.path, issued.token)).resolves.toMatchObject({
      producer: 'workflow/refine',
      activationId: 'activation-1',
    });
    await expect(store.read(issued.path, 'wrong')).rejects.toThrow('Invalid artifact MCP session');
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-mcp-session-'));
  directories.push(path);
  return path;
}

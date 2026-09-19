import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkItemId } from '../../work/index.js';

export interface ArtifactMcpSessionDescriptor {
  readonly token: string;
  readonly workItemId: WorkItemId;
  readonly producer: string;
  readonly runId: string;
  readonly activationId: string;
  readonly readableProducers: readonly string[];
}

/**
 * Ephemeral run-scoped descriptors are intentionally outside a Git workspace.
 * The unpredictable filename is the capability presented by the configured MCP
 * child process; it does not contain artifacts themselves.
 */
export class FileArtifactMcpSessionStore {
  constructor(private readonly root: string) {}

  async issue(
    input: Omit<ArtifactMcpSessionDescriptor, 'token'>,
  ): Promise<{ readonly path: string; readonly token: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = createHash('sha256').update(token).digest('hex');
    const directory = join(this.root, 'sessions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    await writeFile(path, JSON.stringify({ ...input, token }), { encoding: 'utf8', mode: 0o600 });
    return { path, token };
  }

  async read(path: string, token: string): Promise<ArtifactMcpSessionDescriptor> {
    const descriptor = JSON.parse(
      await readFile(path, 'utf8'),
    ) as Partial<ArtifactMcpSessionDescriptor>;
    if (
      descriptor.token !== token ||
      typeof descriptor.workItemId !== 'string' ||
      typeof descriptor.producer !== 'string' ||
      typeof descriptor.runId !== 'string' ||
      typeof descriptor.activationId !== 'string' ||
      !Array.isArray(descriptor.readableProducers)
    )
      throw new Error('Invalid artifact MCP session');
    return descriptor as ArtifactMcpSessionDescriptor;
  }
}

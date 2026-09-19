import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkItemId } from '../../work/index.js';

export interface ArtifactMcpSessionDescriptor {
  readonly workItemId: WorkItemId;
  readonly producer: string;
  readonly runId: string;
  readonly activationId: string;
  readonly readableProducers: readonly string[];
  readonly expiresAt: string;
}

interface StoredArtifactMcpSessionDescriptor extends ArtifactMcpSessionDescriptor {
  readonly tokenHash: string;
}

/**
 * Ephemeral run-scoped descriptors are intentionally outside a Git workspace.
 * The unpredictable filename is the capability presented by the configured MCP
 * child process; it does not contain artifacts themselves.
 */
export class FileArtifactMcpSessionStore {
  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async issue(
    input: ArtifactMcpSessionDescriptor,
  ): Promise<{ readonly path: string; readonly token: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = createHash('sha256').update(token).digest('hex');
    const directory = join(this.root, 'sessions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    await writeFile(
      path,
      JSON.stringify({
        ...input,
        tokenHash: digest(token),
      } satisfies StoredArtifactMcpSessionDescriptor),
      { encoding: 'utf8', mode: 0o600 },
    );
    return { path, token };
  }

  async read(path: string, token: string): Promise<ArtifactMcpSessionDescriptor> {
    const descriptor = JSON.parse(
      await readFile(path, 'utf8'),
    ) as Partial<StoredArtifactMcpSessionDescriptor>;
    if (
      typeof descriptor.tokenHash !== 'string' ||
      !sameDigest(descriptor.tokenHash, digest(token)) ||
      typeof descriptor.workItemId !== 'string' ||
      typeof descriptor.producer !== 'string' ||
      typeof descriptor.runId !== 'string' ||
      typeof descriptor.activationId !== 'string' ||
      !Array.isArray(descriptor.readableProducers) ||
      typeof descriptor.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(descriptor.expiresAt)) ||
      Date.parse(descriptor.expiresAt) <= Date.parse(this.now())
    )
      throw new Error('Invalid artifact MCP session');
    const { tokenHash: _tokenHash, ...session } = descriptor;
    return session as ArtifactMcpSessionDescriptor;
  }

  async revoke(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

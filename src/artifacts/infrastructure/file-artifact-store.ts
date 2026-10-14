import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactPath } from '../contracts/paths.js';

export interface StoredArtifactBytes {
  readonly location: string;
  readonly byteLength: number;
  readonly digest: string;
}

/**
 * Private filesystem byte store. Its locations are opaque implementation
 * details; durable artifact facts carry the location, digest, and length.
 */
export class FileArtifactStore {
  constructor(private readonly root: string) {}

  async write(input: {
    readonly workItemId: string;
    readonly revisionId: string;
    readonly path: ArtifactPath;
    readonly bytes: Uint8Array;
  }): Promise<StoredArtifactBytes> {
    assertSegment(input.workItemId, 'Work item ID');
    return this.writeRevision([input.workItemId], input.revisionId, input.bytes);
  }

  private async writeRevision(
    namespace: readonly string[],
    revisionId: string,
    bytes: Uint8Array,
  ): Promise<StoredArtifactBytes> {
    assertSegment(revisionId, 'Artifact revision ID');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const location = join(...namespace, `${revisionId}.${digest}`);
    const destination = this.absolute(location);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.pending`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      location,
      byteLength: bytes.byteLength,
      digest,
    };
  }

  async writeOperatorInstructions(input: {
    readonly contextScope: string;
    readonly revisionId: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredArtifactBytes> {
    const scopeKey = createHash('sha256').update(input.contextScope).digest('hex');
    return this.writeRevision(['operator-instructions', scopeKey], input.revisionId, input.bytes);
  }

  async read(location: string): Promise<Uint8Array> {
    return readFile(this.absolute(location));
  }

  private absolute(location: string): string {
    const segments = location.split('/');
    for (const segment of segments) assertSegment(segment, 'Artifact store location segment');
    return join(this.root, ...segments);
  }
}

function assertSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  )
    throw new Error(`${label} must be a single filesystem segment`);
}

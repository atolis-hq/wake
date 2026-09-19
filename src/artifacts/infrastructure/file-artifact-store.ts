import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
    assertSegment(input.revisionId, 'Artifact revision ID');
    const location = join(input.workItemId, input.revisionId);
    const destination = this.absolute(location);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.pending`;
    await writeFile(temporary, input.bytes);
    await rename(temporary, destination);
    return {
      location,
      byteLength: input.bytes.byteLength,
      digest: createHash('sha256').update(input.bytes).digest('hex'),
    };
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

import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileArtifactStore,
  artifactPath,
  createArtifactService,
} from '../../../src/artifacts/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];
const context = {
  commandId: 'artifact-command',
  correlationId: correlationId('artifact-test'),
  actor: { kind: 'system' as const, id: 'test' },
  occurredAt: '2026-09-19T12:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('ArtifactService', () => {
  it('durably stages a revision and retains its auditable metadata', async () => {
    const service = createArtifactService(
      new InMemoryEventJournal(new FakeClock()),
      new FileArtifactStore(await directory()),
      { maxWriteBytes: 100, maxWorkItemBytes: 200 },
    );
    const workItemId = workId('artifact-service');
    await service.stageRevision(
      {
        revisionId: 'revision-1',
        path: artifactPath('spec.md'),
        bytes: new TextEncoder().encode('hello'),
        mediaType: 'text/markdown',
      },
      { workItemId, producer: 'workflow-1/refine', runId: 'run-1', activationId: 'activation-1' },
      context,
    );

    await expect(service.get(workItemId)).resolves.toMatchObject({
      workItemId,
      revisions: [
        {
          revisionId: 'revision-1',
          producer: 'workflow-1/refine',
          path: 'spec.md',
          byteLength: 5,
          deleted: false,
          mediaType: 'text/markdown',
        },
      ],
    });
  });

  it('enforces global write and retained-work-item limits', async () => {
    const service = createArtifactService(
      new InMemoryEventJournal(new FakeClock()),
      new FileArtifactStore(await directory()),
      { maxWriteBytes: 3, maxWorkItemBytes: 5 },
    );
    const scope = {
      workItemId: workId('artifact-limits'),
      producer: 'workflow-1/refine',
      runId: 'run-1',
      activationId: 'activation-1',
    };
    await expect(
      service.stageRevision(
        { revisionId: 'too-large', path: artifactPath('spec.md'), bytes: new Uint8Array(4) },
        scope,
        context,
      ),
    ).rejects.toThrow('write exceeds');
    await service.stageRevision(
      { revisionId: 'one', path: artifactPath('spec.md'), bytes: new Uint8Array(3) },
      scope,
      context,
    );
    await expect(
      service.stageRevision(
        { revisionId: 'two', path: artifactPath('spec.md'), bytes: new Uint8Array(3) },
        scope,
        context,
      ),
    ).rejects.toThrow('work item exceeds');
  });

  it('exposes only latest accepted, non-tombstoned revisions', async () => {
    const service = createArtifactService(
      new InMemoryEventJournal(new FakeClock()),
      new FileArtifactStore(await directory()),
      { maxWriteBytes: 100, maxWorkItemBytes: 200 },
    );
    const workItemId = workId('artifact-visible');
    const scope = {
      workItemId,
      producer: 'workflow-1/refine',
      runId: 'run-1',
      activationId: 'accepted',
    };
    await service.stageRevision(
      { revisionId: 'revision-1', path: artifactPath('spec.md'), bytes: new Uint8Array([1]) },
      scope,
      context,
    );
    await service.stageRevision(
      { revisionId: 'revision-2', path: artifactPath('spec.md'), bytes: new Uint8Array([2]) },
      scope,
      { ...context, commandId: 'revision-2' },
    );
    await service.stageTombstone(
      { revisionId: 'tombstone-1', path: artifactPath('spec.md') },
      scope,
      { ...context, commandId: 'tombstone' },
    );
    await service.stageRevision(
      {
        revisionId: 'unaccepted',
        path: artifactPath('private.md'),
        bytes: new Uint8Array([3]),
      },
      { ...scope, activationId: 'unaccepted' },
      { ...context, commandId: 'unaccepted' },
    );

    await expect(
      service.latestPublished(workItemId, async (id) => id === 'accepted'),
    ).resolves.toEqual([]);
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-service-'));
  directories.push(path);
  return path;
}

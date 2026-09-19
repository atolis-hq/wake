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
        workItemId,
        revisionId: 'revision-1',
        producer: 'workflow-1/refine',
        path: artifactPath('spec.md'),
        runId: 'run-1',
        activationId: 'activation-1',
        bytes: new TextEncoder().encode('hello'),
        mediaType: 'text/markdown',
      },
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
    const base = {
      workItemId: workId('artifact-limits'),
      producer: 'workflow-1/refine',
      path: artifactPath('spec.md'),
      runId: 'run-1',
      activationId: 'activation-1',
    };
    await expect(
      service.stageRevision(
        { ...base, revisionId: 'too-large', bytes: new Uint8Array(4) },
        context,
      ),
    ).rejects.toThrow('write exceeds');
    await service.stageRevision({ ...base, revisionId: 'one', bytes: new Uint8Array(3) }, context);
    await expect(
      service.stageRevision({ ...base, revisionId: 'two', bytes: new Uint8Array(3) }, context),
    ).rejects.toThrow('work item exceeds');
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-service-'));
  directories.push(path);
  return path;
}

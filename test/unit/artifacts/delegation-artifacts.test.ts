import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ArtifactContextService,
  createArtifactService,
  createDelegationArtifacts,
  FileArtifactStore,
} from '../../../src/artifacts/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it('qualifies named exact revisions through the injected owner-scoped acceptance query', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wake-delegation-artifacts-'));
  try {
    const journal = new InMemoryEventJournal(new FakeClock());
    const artifacts = createArtifactService(journal, new FileArtifactStore(directory), {
      maxWriteBytes: 100,
      maxWorkItemBytes: 1000,
    });
    const owner = workId('child');
    const accepted = new Set<string>();
    const adapter = createDelegationArtifacts({
      artifacts,
      contexts: new ArtifactContextService(journal, artifacts),
      accepted: async (activationId, item) => item === owner && accepted.has(activationId),
    });
    const context = {
      commandId: 'stage',
      correlationId: correlationId('artifacts'),
      occurredAt: '2026-10-18T12:00:00.000Z',
      actor: { kind: 'system' as const, id: 'test' },
    };
    const reference = { workItemId: owner, revisionId: 'accepted-revision' };
    const child = { workItemId: owner };
    const outputs = [{ name: 'findings', path: 'findings.md' }];
    await artifacts.stageRevision(
      {
        revisionId: reference.revisionId,
        path: 'findings.md',
        bytes: new TextEncoder().encode('accepted'),
      },
      { workItemId: owner, producer: 'child/work', runId: 'run', activationId: 'accepted' },
      context,
    );
    expect(await adapter.qualifyingOutputs(child, outputs)).toBeNull();
    await expect(adapter.validateInputs(child, [reference])).rejects.toThrow(
      'accepted artifact revisions',
    );
    accepted.add('accepted');
    await expect(adapter.validateInputs(child, [reference])).resolves.toBeUndefined();
    await artifacts.stageRevision(
      {
        revisionId: 'draft-revision',
        path: 'findings.md',
        bytes: new TextEncoder().encode('draft'),
      },
      { workItemId: owner, producer: 'child/work', runId: 'next-run', activationId: 'draft' },
      { ...context, commandId: 'draft' },
    );
    expect(await adapter.qualifyingOutputs(child, outputs)).toEqual([
      { name: 'findings', reference },
    ]);
    await expect(
      adapter.validateInputs(child, [{ ...reference, revisionId: 'draft-revision' }]),
    ).rejects.toThrow('accepted artifact revisions');
    expect(
      await adapter.qualifyingOutputs(child, [...outputs, { name: 'missing', path: 'missing.md' }]),
    ).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

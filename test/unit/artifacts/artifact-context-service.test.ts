import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactContextProvenanceKind,
  ArtifactContextService,
  ArtifactMemoryPublicationReason,
  FileArtifactStore,
  artifactPath,
  createArtifactMcpServer,
  createArtifactService,
  type ArtifactRevisionReference,
} from '../../../src/artifacts/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];
const context = {
  commandId: 'context-command',
  correlationId: correlationId('context-test'),
  actor: { kind: 'system' as const, id: 'test' },
  occurredAt: '2026-09-19T12:00:00.000Z',
};
const scope = 'recurring.review';
const first = workId('invocation-1');
const second = workId('invocation-2');

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const path = await mkdtemp(join(tmpdir(), 'wake-artifact-context-'));
  directories.push(path);
  const artifacts = createArtifactService(journal, new FileArtifactStore(path), {
    maxWriteBytes: 100,
    maxWorkItemBytes: 1000,
  });
  const accepted = new Set<string>();
  const isAccepted = async (activationId: string) => accepted.has(activationId);
  let count = 0;

  async function stage(
    workItemId: ReturnType<typeof workId>,
    filePath: string,
    options: { producer?: string; activation?: string; accept?: boolean } = {},
  ): Promise<ArtifactRevisionReference> {
    const revisionId = `revision-${++count}`;
    const activationId = options.activation ?? `activation-${workItemId}-${count}`;
    await artifacts.stageRevision(
      { revisionId, path: artifactPath(filePath), bytes: new TextEncoder().encode(revisionId) },
      {
        workItemId,
        producer: options.producer ?? 'workflow/run',
        runId: `run-${count}`,
        activationId,
      },
      { ...context, commandId: `stage-${count}` },
    );
    if (options.accept !== false) accepted.add(activationId);
    return { workItemId, revisionId };
  }

  const contexts = new ArtifactContextService(journal, artifacts);
  const trigger = (invocationId: string) => ({
    kind: ArtifactContextProvenanceKind.Trigger,
    triggerId: 'review',
    invocationId,
  });
  return { artifacts, contexts, journal, path, accepted: isAccepted, stage, trigger };
}

const ctx = (id: string) => ({ ...context, commandId: id });

describe('ArtifactContextService', () => {
  it('keeps WorkItems isolated without an explicit context', async () => {
    const { artifacts, stage, accepted } = await fixture();
    await stage(first, 'memory.md');
    const view = await artifacts.visibleTo(
      {
        workItemId: second,
        producer: 'workflow/run',
        runId: 'r',
        activationId: 'a',
        readableProducers: new Set(['workflow/run']),
      },
      accepted,
    );
    expect(view).toEqual([]);
  });

  it('advances memory only for exactly one accepted memory.md and exposes it to a fresh invocation', async () => {
    const { artifacts, contexts, stage, trigger, accepted } = await fixture();
    await contexts.enroll(scope, first, trigger('i1'), ctx('enroll-1'));
    const memory = await stage(first, 'memory.md');
    await stage(first, 'private-notes.md');
    const publication = await contexts.publish(
      {
        contextScope: scope,
        workItemId: first,
        publicationId: 'i1',
        successful: true,
        exports: [],
        expectedMemory: null,
      },
      accepted,
      ctx('publish-1'),
    );
    expect(publication).toMatchObject({ reason: ArtifactMemoryPublicationReason.Advanced, memory });

    await contexts.enroll(scope, second, trigger('i2'), ctx('enroll-2'));
    const view = await contexts.get(scope);
    const references = await contexts.references(scope, second);
    // Private/local output is not exported merely because the invocation participated.
    expect(references).toEqual([memory]);
    const local = await stage(second, 'memory.md', { producer: 'workflow/run' });
    const manifest = await artifacts.visibleTo(
      {
        workItemId: second,
        producer: 'workflow/run',
        runId: 'r',
        activationId: 'a',
        readableProducers: new Set(['workflow/run']),
        sharedReferences: references,
        currentMemory: view.memory,
      },
      accepted,
    );
    // Same-path local and shared revisions remain distinct and keep provenance.
    expect(manifest).toEqual([
      expect.objectContaining({ ...local, access: 'local', path: 'memory.md' }),
      expect.objectContaining({
        ...memory,
        access: 'shared',
        path: 'memory.md',
        currentMemory: true,
      }),
    ]);
  });

  it('leaves memory unchanged for failed, missing, draft and ambiguous output', async () => {
    const { contexts, stage, trigger, accepted } = await fixture();
    const publish = (workItemId: typeof first, id: string, successful: boolean) =>
      contexts.publish(
        {
          contextScope: scope,
          workItemId,
          publicationId: id,
          successful,
          exports: [],
          expectedMemory: null,
        },
        accepted,
        ctx(id),
      );
    await contexts.enroll(scope, first, trigger('i1'), ctx('e1'));
    expect((await publish(first, 'missing', true)).reason).toBe(
      ArtifactMemoryPublicationReason.Missing,
    );
    await stage(first, 'memory.md', { accept: false });
    expect((await publish(first, 'draft', true)).reason).toBe(
      ArtifactMemoryPublicationReason.Missing,
    );
    await stage(first, 'memory.md', { producer: 'a' });
    await stage(first, 'memory.md', { producer: 'b' });
    expect((await publish(first, 'ambiguous', true)).reason).toBe(
      ArtifactMemoryPublicationReason.Ambiguous,
    );
    expect((await publish(first, 'failed', false)).reason).toBe(
      ArtifactMemoryPublicationReason.Failed,
    );
    expect((await contexts.get(scope)).memory).toBeNull();
  });

  it('rejects stale expected pointers and replays accepted publication idempotently', async () => {
    const { contexts, stage, trigger, accepted } = await fixture();
    await contexts.enroll(scope, first, trigger('i1'), ctx('e1'));
    await contexts.enroll(scope, second, trigger('i2'), ctx('e2'));
    const one = await stage(first, 'memory.md');
    const input = (
      workItemId: typeof first,
      publicationId: string,
      expected: typeof one | null,
    ) => ({
      contextScope: scope,
      workItemId,
      publicationId,
      successful: true,
      exports: [],
      expectedMemory: expected,
    });
    const published = await contexts.publish(input(first, 'i1', null), accepted, ctx('p1'));
    // A crash-recovery replay returns the durable receipt rather than conflicting.
    await expect(contexts.publish(input(first, 'i1', null), accepted, ctx('p1'))).resolves.toEqual(
      published,
    );
    await stage(second, 'memory.md');
    await expect(contexts.publish(input(second, 'i2', null), accepted, ctx('p2'))).rejects.toThrow(
      'Stale artifact memory pointer',
    );
    await expect(
      contexts.publish(input(second, 'i2', one), accepted, ctx('p2')),
    ).resolves.toMatchObject({ reason: ArtifactMemoryPublicationReason.Advanced });
  });

  it('reconciles publication after restart and retains exact references after replacement and deletion', async () => {
    const { artifacts, contexts, journal, path, stage, trigger, accepted } = await fixture();
    await contexts.enroll(scope, first, trigger('i1'), ctx('enroll'));
    const memory = await stage(first, 'memory.md');
    const input = {
      contextScope: scope,
      workItemId: first,
      publicationId: 'i1',
      successful: true,
      exports: [],
      expectedMemory: null,
    };
    // Acceptance precedes publication; recovery must work without a context receipt.
    const restartedArtifacts = createArtifactService(journal, new FileArtifactStore(path), {
      maxWriteBytes: 100,
      maxWorkItemBytes: 1000,
    });
    const restarted = new ArtifactContextService(journal, restartedArtifacts);
    const receipt = await restarted.publish(input, accepted, ctx('publish'));
    await stage(first, 'memory.md');
    await artifacts.stageTombstone(
      { revisionId: 'deleted-memory', path: 'memory.md' },
      { workItemId: first, producer: 'workflow/run', runId: 'delete', activationId: 'delete' },
      ctx('delete'),
    );
    const afterDeletion = async (id: string) => id === 'delete' || accepted(id);
    expect(await artifacts.latestPublished(first, afterDeletion)).toEqual([]);
    const recovered = new ArtifactContextService(journal, restartedArtifacts);
    await expect(recovered.publish(input, afterDeletion, ctx('replay'))).resolves.toEqual(receipt);
    await recovered.enroll(scope, second, trigger('i2'), ctx('fresh'));
    const references = await recovered.references(scope, second);
    expect(references).toEqual([memory]);
    const manifest = await restartedArtifacts.visibleTo(
      {
        workItemId: second,
        producer: 'fresh/run',
        runId: 'fresh',
        activationId: 'fresh',
        readableProducers: new Set(),
        sharedReferences: references,
        currentMemory: (await recovered.get(scope)).memory,
      },
      afterDeletion,
    );
    expect(manifest).toEqual([expect.objectContaining({ ...memory, currentMemory: true })]);
    expect(new TextDecoder().decode(await restartedArtifacts.read(manifest[0]!.location!))).toBe(
      memory.revisionId,
    );
  });

  it('denies publishing foreign, unaccepted or non-enrolled revisions', async () => {
    const { contexts, stage, trigger, accepted } = await fixture();
    await contexts.enroll(scope, first, trigger('i1'), ctx('e1'));
    const foreign = await stage(second, 'x.md');
    const draft = await stage(first, 'x.md', { accept: false });
    const base = { contextScope: scope, successful: true, expectedMemory: null };
    await expect(
      contexts.publish(
        { ...base, workItemId: first, publicationId: 'a', exports: [foreign] },
        accepted,
        ctx('a'),
      ),
    ).rejects.toThrow('another work item');
    await expect(
      contexts.publish(
        { ...base, workItemId: first, publicationId: 'b', exports: [draft] },
        accepted,
        ctx('b'),
      ),
    ).rejects.toThrow('not an accepted revision');
    await expect(
      contexts.publish(
        { ...base, workItemId: second, publicationId: 'c', exports: [] },
        accepted,
        ctx('c'),
      ),
    ).rejects.toThrow('not enrolled');
    await expect(contexts.references(scope, second)).rejects.toThrow('not enrolled');
  });

  it('grants parent and child access directionally without sibling inference', async () => {
    const { contexts, stage, accepted } = await fixture();
    const parent = workId('parent');
    const child = workId('child');
    const sibling = workId('sibling');
    const selected = await stage(parent, 'brief.md');
    await stage(parent, 'other.md');
    const output = await stage(child, 'result.md');
    const draft = await stage(child, 'draft.md', { accept: false });
    await stage(sibling, 'sibling.md');
    await contexts.registerChild(
      {
        delegationId: 'd1',
        parentWorkItemId: parent,
        childWorkItemId: child,
        childReferences: [selected],
      },
      accepted,
      ctx('d1'),
    );
    await contexts.registerChild(
      {
        delegationId: 'd1',
        parentWorkItemId: parent,
        childWorkItemId: child,
        childReferences: [selected],
      },
      accepted,
      ctx('d1'),
    );
    await expect(contexts.childReferences(parent, child)).resolves.toEqual([selected]);
    await expect(contexts.childReferences(parent, sibling)).resolves.toEqual([]);
    await expect(contexts.parentReferences(parent, accepted)).resolves.toEqual([output]);
    await expect(contexts.parentReferences(sibling, accepted)).resolves.toEqual([]);
    await expect(
      contexts.registerChild(
        {
          delegationId: 'd2',
          parentWorkItemId: parent,
          childWorkItemId: child,
          childReferences: [draft],
        },
        accepted,
        ctx('d2'),
      ),
    ).rejects.toThrow('not an accepted revision');
  });

  it('serves shared revisions read-only through MCP and denies unauthorized revisions', async () => {
    const { artifacts, stage, accepted } = await fixture();
    const shared = await stage(first, 'memory.md');
    const unrelated = await stage(workId('unrelated'), 'memory.md');
    await artifacts.stageRevision(
      {
        revisionId: shared.revisionId,
        path: 'memory.md',
        bytes: new TextEncoder().encode('local'),
      },
      {
        workItemId: second,
        producer: 'workflow/run',
        runId: 'run-x',
        activationId: 'activation-x',
      },
      ctx('collision'),
    );
    const server = createArtifactMcpServer(artifacts, {
      workItemId: second,
      producer: 'workflow/run',
      runId: 'run-x',
      activationId: 'activation-x',
      readableProducers: new Set(['workflow/run']),
      sharedReferences: [shared],
      currentMemory: shared,
      nextRevisionId: () => 'revision-new',
      commandContext: () => context,
      acceptedActivation: accepted,
      assertActive: async () => undefined,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await expect(
      client.callTool({
        name: 'wake_artifacts_read',
        arguments: { revisionId: shared.revisionId, workItemId: first },
      }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ text: shared.revisionId })] });
    await expect(
      client.callTool({
        name: 'wake_artifacts_read',
        arguments: { revisionId: shared.revisionId },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      client.callTool({
        name: 'wake_artifacts_read',
        arguments: { revisionId: shared.revisionId, workItemId: second },
      }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ text: 'local' })] });
    const listed = await client.callTool({ name: 'wake_artifacts_list', arguments: {} });
    expect(JSON.stringify(listed)).toContain('currentMemory');
    await expect(
      client.callTool({
        name: 'wake_artifacts_patch',
        arguments: { revisionId: shared.revisionId, find: shared.revisionId, replace: 'x' },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      client.callTool({
        name: 'wake_artifacts_read',
        arguments: { revisionId: unrelated.revisionId },
      }),
    ).resolves.toMatchObject({ isError: true });
    // A write lands in the caller's own WorkItem namespace, never the shared owner's.
    await client.callTool({
      name: 'wake_artifacts_write',
      arguments: { path: 'memory.md', content: 'mine' },
    });
    expect((await artifacts.get(second))?.revisions).toHaveLength(2);
    expect((await artifacts.get(first))?.revisions).toHaveLength(1);
  });
});

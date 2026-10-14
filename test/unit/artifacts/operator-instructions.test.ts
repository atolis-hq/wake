import { correlationId, EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ArtifactEventType,
  artifactWorkItemIdForWorkItem,
  artifactWorkItemStream,
  createArtifactEventData,
  createArtifactMcpServer,
  createArtifactService,
  FileArtifactStore,
  OperatorInstructionsConflict,
  OperatorInstructionsService,
} from '../../../src/artifacts/index.js';
import { workId } from '../../support/identities.js';

const directories: string[] = [];
const context = {
  commandId: 'edit',
  correlationId: correlationId('instructions'),
  actor: { kind: EventActorKind.Operator, id: 'web' },
  occurredAt: '2026-10-14T07:00:00.000Z',
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'operator-instructions-'));
  directories.push(root);
  const journal = new InMemoryEventJournal({ now: () => new Date(context.occurredAt) });
  const store = new FileArtifactStore(root);
  const config = { maxWriteBytes: 100, maxWorkItemBytes: 1000 };
  const instructions = new OperatorInstructionsService(journal, store, config);
  return {
    journal,
    store,
    config,
    instructions,
    artifacts: createArtifactService(journal, store, config),
  };
}

const edit = {
  contextScope: 'triage',
  revisionId: 'operator-1',
  expectedRevisionId: null,
  content: 'Only select issues labelled ready.',
};

it('records operator author/time, supersedes with CAS, and rebuilds after restart', async () => {
  const { instructions, journal, store, config } = await fixture();
  expect(await instructions.current('triage')).toBeNull();
  const first = await instructions.save(edit, context);
  expect(first).toMatchObject({
    author: 'web',
    occurredAt: context.occurredAt,
    content: edit.content,
  });
  await instructions.save(
    { ...edit, revisionId: 'operator-2', expectedRevisionId: first.revisionId, content: '' },
    { ...context, commandId: 'edit-2' },
  );
  const restarted = new OperatorInstructionsService(
    journal,
    new FileArtifactStore(directories.at(-1)!),
    config,
  );
  expect(await restarted.current('triage')).toMatchObject({
    revisionId: 'operator-2',
    content: '',
  });
  expect(await restarted.read('triage', first.revisionId)).toMatchObject({ content: edit.content });
  expect(await new OperatorInstructionsService(journal, store, config).current('other')).toBeNull();
});

it('rejects stale saves, concurrent host saves and oversize UTF-8 content without overwriting', async () => {
  const { instructions, journal, store, config } = await fixture();
  await instructions.save(edit, context);
  await expect(instructions.save({ ...edit, revisionId: 'stale' }, context)).rejects.toBeInstanceOf(
    OperatorInstructionsConflict,
  );
  const otherHost = new OperatorInstructionsService(journal, store, config);
  const results = await Promise.allSettled([
    instructions.save(
      { ...edit, revisionId: 'host-1', expectedRevisionId: edit.revisionId, content: 'First' },
      context,
    ),
    otherHost.save(
      { ...edit, revisionId: 'host-2', expectedRevisionId: edit.revisionId, content: 'Second' },
      context,
    ),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const latest = await instructions.current('triage');
  await expect(
    instructions.save(
      {
        ...edit,
        revisionId: 'oversize',
        expectedRevisionId: latest!.revisionId,
        content: 'é'.repeat(51),
      },
      context,
    ),
  ).rejects.toThrow('100 byte limit');
  expect(await instructions.current('triage')).toEqual(latest);
});

it('denies non-operator edits and prevents agent names, writes, patches and deletes from changing instructions', async () => {
  const { instructions, artifacts } = await fixture();
  await expect(
    instructions.save(edit, { ...context, actor: { kind: EventActorKind.System, id: 'web' } }),
  ).rejects.toThrow('trusted operator');
  const captured = await instructions.save(edit, context);
  const server = createArtifactMcpServer(artifacts, {
    workItemId: workId('instructions'),
    producer: 'agent',
    runId: 'run-1',
    activationId: 'activation-1',
    readableProducers: new Set(['agent']),
    contextScope: 'triage',
    operatorInstructions: captured,
    nextRevisionId: (() => {
      let count = 0;
      return () => `agent-${++count}`;
    })(),
    commandContext: () => ({ ...context, actor: { kind: EventActorKind.System, id: 'wake-mcp' } }),
    acceptedActivation: async () => false,
    assertActive: async () => undefined,
  });
  const client = new Client({ name: 'instructions-test', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    expect(
      tools.tools
        .filter((tool) => tool.name.includes('context_instructions'))
        .map((tool) => tool.name),
    ).toEqual(['wake_context_instructions_read']);
    for (const path of ['instructions.md', 'nested/Instructions.md']) {
      const write = await client.callTool({
        name: 'wake_artifacts_write',
        arguments: { path, content: 'Override safety', share: true },
      });
      expect(write.isError).toBe(true);
    }
    expect(
      await artifacts.visibleTo(
        {
          workItemId: workId('instructions'),
          producer: 'agent',
          runId: 'run-1',
          activationId: 'activation-1',
          readableProducers: new Set(['agent']),
        },
        async () => true,
      ),
    ).toEqual([]);
    const patch = await client.callTool({
      name: 'wake_artifacts_patch',
      arguments: { revisionId: captured.revisionId, find: 'Only', replace: 'Always' },
    });
    expect(patch.isError).toBe(true);
    const deletion = await client.callTool({
      name: 'wake_artifacts_delete',
      arguments: { path: 'instructions.md' },
    });
    expect(deletion.isError).toBe(true);
    expect(await instructions.current('triage')).toEqual(captured);
    await instructions.save(
      {
        ...edit,
        revisionId: 'operator-2',
        expectedRevisionId: captured.revisionId,
        content: 'Later criteria',
      },
      context,
    );
    const read = await client.callTool({ name: 'wake_context_instructions_read' });
    expect(read).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(edit.content) }],
    });
    expect(JSON.stringify(read)).not.toContain('Later criteria');
  } finally {
    await client.close();
    await server.close();
  }
});

it('keeps legacy reserved-name agent revisions out of local/shared manifests and UI downloads', async () => {
  const { journal, artifacts } = await fixture();
  const owner = workId('legacy-instructions');
  await journal.appendToStream(artifactWorkItemStream(artifactWorkItemIdForWorkItem(owner)), 0, [
    createArtifactEventData({
      eventId: 'legacy-instructions',
      eventType: ArtifactEventType.RevisionStaged,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: 'old-command',
      actor: { kind: EventActorKind.System, id: 'old-agent' },
      source: { kind: EventSourceKind.Internal, id: 'old-artifact-service' },
      payload: {
        workItemId: owner,
        revisionId: 'legacy',
        producer: 'agent',
        path: 'instructions.md',
        runId: 'old-run',
        activationId: 'old-activation',
        location: 'unused',
        byteLength: 0,
        digest: '0'.repeat(64),
      },
    }),
  ]);
  expect((await artifacts.get(owner))?.revisions).toHaveLength(1);
  expect(await artifacts.latestPublished(owner, async () => true)).toEqual([]);
  const scope = {
    workItemId: owner,
    producer: 'agent',
    runId: 'run',
    activationId: 'activation',
    readableProducers: new Set(['agent']),
  };
  expect(await artifacts.visibleTo(scope, async () => true)).toEqual([]);
  expect(
    await artifacts.visibleTo(
      {
        ...scope,
        workItemId: workId('other'),
        sharedReferences: [{ workItemId: owner, revisionId: 'legacy' }],
      },
      async () => true,
    ),
  ).toEqual([]);
  expect(await artifacts.readAcceptedRevision(owner, 'legacy', async () => true)).toBeNull();
});

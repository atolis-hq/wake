import { correlationId } from '@atolis-hq/eventing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it, vi } from 'vitest';
import {
  DelegationAttentionError,
  DelegationConflictError,
  DeliveryRejectionError,
} from '../../../src/orchestration/index.js';
import { registerDelegationTools } from '../../../src/surfaces/mcp/delegation.js';
import { workId } from '../../support/identities.js';

const caller = { workflowInstanceId: 'parent', activationId: 'attention', runId: 'run' } as never;

async function connect(orchestration: object) {
  const server = new McpServer({ name: 'test', version: '1' });
  registerDelegationTools(server, {
    orchestration: orchestration as never,
    caller: async () => caller,
    commandContext: () => ({
      commandId: 'command',
      correlationId: correlationId('mcp'),
      occurredAt: '2026-10-19T12:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
    }),
  });
  const client = new Client({ name: 'client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const text = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as unknown;

const reply = {
  childWorkItemId: workId('2'),
  blockerId: 'grant:context:act',
  expectedRevision: 1,
  references: [{ workItemId: workId('1'), revisionId: 'answer-1' }],
};

it('maps an accepted wake_delegation_respond reply to the bound caller and returns the attention', async () => {
  const respond = vi.fn(async () => ({ cohortId: 'cohort-1', responses: [reply] }));
  const client = await connect({ respondToDelegationAttention: respond });
  const result = await client.callTool({ name: 'wake_delegation_respond', arguments: reply });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatchObject({ cohortId: 'cohort-1' });
  // Arguments pass through unchanged while the caller and context come from the bound session.
  expect(respond).toHaveBeenCalledWith(
    caller,
    reply,
    expect.objectContaining({ commandId: 'command' }),
  );
  await client.close();
});

it('rejects forged identity arguments and maps typed rejections to tool errors', async () => {
  const respond = vi.fn(async () => {
    throw new DelegationAttentionError('not-answerable', 'Only an assignment-context blocker');
  });
  const client = await connect({ respondToDelegationAttention: respond });
  const forged = await client.callTool({
    name: 'wake_delegation_respond',
    arguments: { ...reply, runId: 'forged' },
  });
  expect(forged.isError).toBe(true);
  expect(respond).not.toHaveBeenCalled();
  const rejected = await client.callTool({ name: 'wake_delegation_respond', arguments: reply });
  expect(rejected.isError).toBe(true);
  expect(text(rejected)).toEqual({
    code: 'not-answerable',
    message: 'Only an assignment-context blocker',
  });
  await client.close();
});

const selection = {
  requestId: 'select-1',
  expectedRevision: 0,
  entries: [
    {
      cohortId: 'cohort-1',
      assignmentId: 'a',
      output: { childWorkItemId: workId('2'), outputName: 'change' },
    },
  ],
};

it('binds delivery selection, candidate and QA to the session caller and maps typed rejections', async () => {
  const select = vi.fn(async () => ({ replay: false }));
  const candidate = vi.fn(async () => {
    throw new DeliveryRejectionError('source-unavailable', 'Ref is missing');
  });
  const qa = vi.fn(async () => ({ replay: false }));
  const client = await connect({
    selectDelivery: select,
    recordDeliveryCandidate: candidate,
    recordDeliveryQa: qa,
  });
  expect(
    (await client.callTool({ name: 'wake_delivery_select', arguments: selection })).isError,
  ).not.toBe(true);
  expect(select).toHaveBeenCalledWith(
    caller,
    selection,
    expect.objectContaining({ commandId: 'command' }),
  );
  const rejected = await client.callTool({
    name: 'wake_delivery_candidate',
    arguments: {
      candidateId: 'cand-1',
      selectionRevision: 1,
      repositories: [
        {
          resourceId: 'repo',
          source: {
            kind: 'retained-ref',
            ref: 'refs/wake/delivery/root/cand-1/repo',
            revision: 'a'.repeat(40),
            contributions: [{ childWorkItemId: workId('2'), outputName: 'change' }],
          },
        },
      ],
    },
  });
  expect(rejected.isError).toBe(true);
  expect(text(rejected)).toEqual({ code: 'source-unavailable', message: 'Ref is missing' });
  // Forged identity or a verdict that is not part of the vocabulary never reaches the service.
  const forged = await client.callTool({
    name: 'wake_delivery_qa',
    arguments: {
      qaId: 'qa-1',
      candidateId: 'cand-1',
      verdict: 'approved',
      revisions: [{ resourceId: 'repo', revision: 'a'.repeat(40) }],
      environment: { available: true },
      runId: 'forged',
    },
  });
  expect(forged.isError).toBe(true);
  expect(qa).not.toHaveBeenCalled();
  await client.close();
});

it('maps an open-attention submission conflict to a typed tool error', async () => {
  const client = await connect({
    submitDelegation: async () => {
      throw new DelegationConflictError('attention-open', 'Submit after the cohort settles');
    },
  });
  const result = await client.callTool({
    name: 'wake_delegation_submit',
    arguments: {
      cohortId: 'second',
      assignments: [
        {
          assignmentId: 'a',
          objective: 'Do it',
          criteria: ['Done'],
          workflowName: 'child',
          context: [],
          outputs: [{ name: 'out', path: 'out.md' }],
        },
      ],
    },
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toMatchObject({ code: 'attention-open' });
  await client.close();
});

it('binds maintenance reports to the session and rejects forged identities', async () => {
  const maintain = vi.fn(async () => ({ replay: false }));
  const client = await connect({ recordDeliveryMaintenance: maintain });
  const command = {
    maintenanceId: 'retarget-1',
    target: { childWorkItemId: workId('2'), outputName: 'change' },
    kind: 'retarget',
    expectedRevision: 'a'.repeat(40),
    revision: 'b'.repeat(40),
    pullRequestBase: 'main',
  };
  expect(
    (await client.callTool({ name: 'wake_delivery_maintenance', arguments: command })).isError,
  ).not.toBe(true);
  expect(maintain).toHaveBeenCalledWith(
    caller,
    command,
    expect.objectContaining({ commandId: 'command' }),
  );
  expect(
    (
      await client.callTool({
        name: 'wake_delivery_maintenance',
        arguments: { ...command, runId: 'forged' },
      })
    ).isError,
  ).toBe(true);
  expect(maintain).toHaveBeenCalledTimes(1);
  await client.close();
});

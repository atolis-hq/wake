import { InMemoryProcessorStateStore } from '@atolis-hq/eventing/memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowsOversightTools,
  integrationsConfigSchema,
  oversightRepositories,
  registerDeliveryOversightTools,
} from '../../../../src/integrations/index.js';
import { OversightGitHub } from '../../../support/oversight-github.js';

const sessions: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function fixture() {
  const github = new OversightGitHub();
  const server = new McpServer({ name: 'oversight-test', version: '1' });
  let queue: Promise<unknown> = Promise.resolve();
  let active = true;
  registerDeliveryOversightTools(server, {
    repositories: oversightRepositories(
      integrationsConfigSchema.parse({
        github: { enabled: true, repositories: [{ owner: 'owner', repo: 'repo' }] },
      }),
    ),
    invocationId: 'invocation-1',
    state: new InMemoryProcessorStateStore(),
    gh: github.gh,
    assertActive: async () => {
      if (!active) throw new Error('Session revoked');
    },
    serialise: async (operation) => {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  sessions.push(client, server);
  const assign = (number: number, repository = 'owner/repo') =>
    client.callTool({
      name: 'wake_github_assign',
      arguments: { candidate: { repository, number } },
    });
  return {
    github,
    client,
    assign,
    revoke: () => {
      active = false;
    },
  };
}

describe('scoped oversight GitHub authority', () => {
  it('denies out-of-scope repositories, closed/other-assigned targets and revoked sessions without mutation', async () => {
    const f = await fixture();
    expect(await f.assign(1, 'outside/repo')).toMatchObject({ isError: true });
    expect(f.github.calls).toEqual([]);
    f.github.closed.add(1);
    expect(await f.assign(1)).toMatchObject({ isError: true });
    f.github.assignments.set(2, ['someone-else']);
    expect(await f.assign(2)).toMatchObject({ isError: true });
    expect(
      await f.client.callTool({
        name: 'wake_github_read',
        arguments: { repository: 'outside/repo', operation: 'issues' },
      }),
    ).toMatchObject({ isError: true });
    f.revoke();
    const count = f.github.calls.length;
    expect(await f.assign(3)).toMatchObject({ isError: true });
    expect(f.github.calls).toHaveLength(count);
    expect(f.github.edits).toBe(0);
  });

  it('serialises competing selections and repeats only observation for an already assigned target', async () => {
    const f = await fixture();
    const outcomes = await Promise.all([f.assign(1), f.assign(2)]);
    expect(outcomes[0]).not.toHaveProperty('isError', true);
    expect(outcomes[1]).toMatchObject({ isError: true });
    expect(await f.assign(1)).not.toHaveProperty('isError', true);
    expect(f.github.edits).toBe(1);
  });

  it('exposes fixed read operations including base comparison, never arbitrary gh flags or mutation', async () => {
    const f = await fixture();
    const args = ['api', '--method', 'GET', 'repos/owner/repo/compare/main...abcdef1234'];
    f.github.evidence.set(args.join(' '), { status: 'identical' });
    expect(
      await f.client.callTool({
        name: 'wake_github_read',
        arguments: {
          repository: 'owner/repo',
          operation: 'compare',
          base: 'main',
          commit: 'abcdef1234',
        },
      }),
    ).toMatchObject({ content: [{ text: JSON.stringify({ status: 'identical' }) }] });
    expect(f.github.calls).toEqual([args]);
    expect(
      await f.client.callTool({
        name: 'wake_github_read',
        arguments: { repository: 'owner/repo', operation: 'merge' },
      }),
    ).toMatchObject({ isError: true });
    expect(f.github.edits).toBe(0);
  });
});

describe('oversight capability configuration', () => {
  it('requires both explicitly allowed tools', () => {
    expect(allowsOversightTools(undefined)).toBe(false);
    expect(allowsOversightTools(['mcp__wake'])).toBe(false);
    expect(allowsOversightTools(['mcp__wake__wake_github_read'])).toBe(false);
    expect(allowsOversightTools(['mcp__wake__wake_github_assign'])).toBe(false);
    expect(
      allowsOversightTools(['mcp__wake__wake_github_read', 'mcp__wake__wake_github_assign']),
    ).toBe(true);
  });
  it('derives exact scope from enabled GitHub integration configuration', () => {
    expect(
      oversightRepositories(
        integrationsConfigSchema.parse({
          github: {
            provider: 'github',
            enabled: true,
            repositories: [
              { owner: 'one', repo: 'first' },
              { owner: 'two', repo: 'second' },
            ],
          },
        }),
      ),
    ).toEqual(['one/first', 'two/second']);
  });
  it.each([
    undefined,
    {},
    { github: { enabled: false, repositories: [{ owner: 'owner', repo: 'repo' }] } },
  ])('fails explicitly when integration is absent or disabled', (integrations) => {
    expect(() => oversightRepositories(integrations)).toThrow(
      'require enabled integrations.github',
    );
  });
});

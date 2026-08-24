import { describe, expect, it, vi } from 'vitest';
import { DeliveryIntentKind } from '../../../src/integrations/delivery/contracts/vocabulary.js';
import { gitHubProviderDefinition } from '../../../src/integrations/github/provider.js';
import { InMemoryEventJournal, InMemoryProjectionStore } from '../../../src/persistence/index.js';
import {
  BuiltInResourceKind,
  createResourceLookup,
  createResourceService,
} from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId } from '../../support/identities.js';

const octokit = vi.hoisted(() => ({ createComment: vi.fn() }));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    readonly rest = { issues: { createComment: octokit.createComment } };
    constructor(_options: unknown) {}
  },
}));

const replyIntent = {
  intentEventId: 'intent-1' as never,
  globalPosition: 1,
  workflowInstanceId: 'workflow-1',
  activationId: 'activation-1',
  kind: DeliveryIntentKind.ReplyPublish,
  resourceId: resId('issue-1'),
  payload: { kind: DeliveryIntentKind.ReplyPublish, body: 'hello' },
  state: 'pending',
  attempts: 0,
  occurrenceOrdinal: 0,
} as const;

describe('GitHub adapter write health', () => {
  it('records a per-repository write success after a confirmed delivery', async () => {
    vi.clearAllMocks();
    octokit.createComment.mockResolvedValue({ data: { id: 99 } });
    const provider = await composeProvider();

    const result = await provider.delivery.deliver(replyIntent, new AbortController().signal);

    expect(result).toMatchObject({ kind: 'confirmed' });
    const checks = provider.health!();
    const write = checks.find((c) => c.scope === 'org/repo' && c.channel === 'deliver')!;
    expect(write.successCount).toBe(1);
    expect(write.failureCount).toBe(0);
    expect(write.status).toBe('ok');
  });

  it('records a per-repository write failure after a rejected delivery', async () => {
    vi.clearAllMocks();
    octokit.createComment.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const provider = await composeProvider();

    const result = await provider.delivery.deliver(replyIntent, new AbortController().signal);

    expect(result).toMatchObject({ kind: 'failed' });
    const checks = provider.health!();
    const write = checks.find((c) => c.scope === 'org/repo' && c.channel === 'deliver')!;
    expect(write.failureCount).toBe(1);
    expect(write.status).toBe('degraded');
    expect(write.detail).toContain('403');
  });
});

describe('GitHub adapter commands', () => {
  it('exposes built-in commands plus any configured extras', async () => {
    const provider = await composeProvider({ commands: ['/deploy'] });

    expect(provider.commands!()).toEqual([
      { syntax: '/approved' },
      { syntax: '/accepted' },
      { syntax: '/changes' },
      { syntax: '/retry' },
      { syntax: '/extend' },
      { syntax: '/deploy' },
    ]);
  });

  it('exposes only the built-in commands when none are configured', async () => {
    const provider = await composeProvider();

    expect(provider.commands!()).toEqual([
      { syntax: '/approved' },
      { syntax: '/accepted' },
      { syntax: '/changes' },
      { syntax: '/retry' },
      { syntax: '/extend' },
    ]);
  });
});

async function composeProvider(extraConfig: { readonly commands?: readonly string[] } = {}) {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const lookup = createResourceLookup({ journal, projections: new InMemoryProjectionStore() });
  const resources = createResourceService(journal, lookup);
  await resources.discover(
    {
      resourceId: replyIntent.resourceId,
      kind: BuiltInResourceKind.Issue,
      externalKey: { adapter: 'github', key: 'org/repo#5' },
      capabilities: [],
    },
    {
      commandId: 'setup-1',
      correlationId: 'setup' as never,
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'integration', id: 'github' },
    },
  );

  return gitHubProviderDefinition.create({
    adapter: 'github' as never,
    config: gitHubProviderDefinition.parseConfig({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'org', repo: 'repo' }],
      ...extraConfig,
    }),
    services: { resources } as never,
  });
}

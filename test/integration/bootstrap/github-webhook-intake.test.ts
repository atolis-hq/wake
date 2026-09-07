import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createImmediatePollRequester } from '../../../src/bootstrap/integration-runtime.js';
import { createProviderWebhookReceiver } from '../../../src/bootstrap/surface-cli-applications.js';
import { adapterId } from '../../../src/integrations/contracts/identifiers.js';
import type { ProviderInstance } from '../../../src/integrations/contracts/provider.js';
import { gitHubConfigSchema } from '../../../src/integrations/github/contracts/config.js';
import { createGitHubAdapterHealthRegistry } from '../../../src/integrations/github/infrastructure/adapter-health-registry.js';
import { GitHubWebhookStateStore } from '../../../src/integrations/github/infrastructure/webhook-state.js';
import { createGitHubWebhook } from '../../../src/integrations/github/infrastructure/webhook.js';
import { createSurfaceHttpServer } from '../../../src/surfaces/api/http-server.js';

describe('composed GitHub webhook intake', () => {
  it('routes a verified HTTP delivery to one coalesced interval-bypassing adapter poll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-intake-'));
    const adapter = adapterId('github');
    const config = gitHubConfigSchema.parse({
      enabled: true,
      repositories: [{ owner: 'atolis-hq', repo: 'wake' }],
      webhooks: { enabled: true },
    });
    const webhook = createGitHubWebhook(
      adapter,
      config,
      'https://wake.example',
      root,
      { getHook: vi.fn(), createHook: vi.fn(), updateHook: vi.fn() },
      createGitHubAdapterHealthRegistry(config.repositories),
    );
    let releasePoll!: () => void;
    const polling = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const source = {
      poll: vi.fn(async () => {
        await polling;
        return [];
      }),
    };
    const provider = {
      adapter,
      source,
      eventTypes: [],
      webhook,
    } as unknown as ProviderInstance;
    const requestImmediatePoll = createImmediatePollRequester(
      [provider],
      new InMemoryEventJournal({ now: () => new Date('2026-09-07T00:00:00.000Z') }),
      root,
    );
    const receiver = createProviderWebhookReceiver([provider], requestImmediatePoll);
    const server = createSurfaceHttpServer({
      dispatcher: { dispatch: async () => undefined },
      credentials: {
        accessKey: 'operator-key',
        sessionPassword: Buffer.alloc(32, 7).toString('base64url'),
        createdAt: '2026-09-07T00:00:00.000Z',
      },
      webhookReceiver: receiver,
    });
    const state = await new GitHubWebhookStateStore(root, adapter).load('atolis-hq', 'wake');
    const body = Buffer.from(JSON.stringify({ repository: { full_name: 'atolis-hq/wake' } }));
    const signature = `sha256=${createHmac('sha256', state.secret).update(body).digest('hex')}`;

    try {
      const first = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-hub-signature-256': signature,
        },
        payload: body,
      });
      await vi.waitFor(() => expect(source.poll).toHaveBeenCalledOnce());
      const second = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-hub-signature-256': signature,
        },
        payload: body,
      });

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(source.poll).toHaveBeenCalledWith(expect.any(AbortSignal), { bypassInterval: true });
      expect(source.poll).toHaveBeenCalledOnce();
    } finally {
      releasePoll();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

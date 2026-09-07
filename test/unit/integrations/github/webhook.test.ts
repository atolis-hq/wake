import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adapterId } from '../../../../src/integrations/contracts/identifiers.js';
import { gitHubConfigSchema } from '../../../../src/integrations/github/contracts/config.js';
import { createGitHubAdapterHealthRegistry } from '../../../../src/integrations/github/infrastructure/adapter-health-registry.js';
import { GitHubWebhookStateStore } from '../../../../src/integrations/github/infrastructure/webhook-state.js';
import { createGitHubWebhook } from '../../../../src/integrations/github/infrastructure/webhook.js';

const repository = { owner: 'atolis-hq', repo: 'wake' };

describe('GitHub webhooks', () => {
  it('defaults to disabled and does not accept delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-'));
    const webhook = createWebhook(root, false);
    await expect(webhook.receive(Buffer.from('{}'), {}, vi.fn())).resolves.toBe(404);
  });

  it('persists ownership, updates only the saved hook, and validates raw HMAC bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-'));
    const hooks = {
      getHook: vi.fn(),
      createHook: vi.fn().mockResolvedValue(42),
      updateHook: vi.fn(),
    };
    const webhook = createWebhook(root, true, hooks);
    await webhook.provision();
    expect(hooks.createHook).toHaveBeenCalledOnce();
    const saved = await new GitHubWebhookStateStore(root, adapterId('github')).load(
      'atolis-hq',
      'wake',
    );
    const body = Buffer.from(JSON.stringify({ repository: { full_name: 'atolis-hq/wake' } }));
    const signature = `sha256=${createHmac('sha256', saved.secret).update(body).digest('hex')}`;
    const trigger = vi.fn();
    await expect(
      webhook.receive(
        body,
        { 'x-hub-signature-256': signature, 'x-github-event': 'issues' },
        trigger,
      ),
    ).resolves.toBe(202);
    expect(trigger).toHaveBeenCalledOnce();
    await webhook.provision();
    expect(hooks.updateHook).toHaveBeenCalledWith(expect.objectContaining({ hookId: 42 }));
    await expect(webhook.receive(body, { 'x-github-event': 'issues' }, trigger)).resolves.toBe(401);
  });

  it('replaces a remotely deleted managed hook and reports provisioning failures immediately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-'));
    const health = createGitHubAdapterHealthRegistry([repository]);
    const hooks = {
      getHook: vi.fn().mockRejectedValue({ status: 404 }),
      createHook: vi.fn().mockResolvedValue(43),
      updateHook: vi.fn(),
    };
    const state = new GitHubWebhookStateStore(root, adapterId('github'));
    await state.save('atolis-hq', 'wake', { secret: 'existing', hookId: 42 });
    const config = gitHubConfigSchema.parse({
      enabled: true,
      repositories: [repository],
      webhooks: { enabled: true },
    });
    const webhook = createGitHubWebhook(
      adapterId('github'),
      config,
      'https://new.example/',
      root,
      hooks,
      health,
    );
    await webhook.provision();
    expect(hooks.createHook).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://new.example/webhooks/github' }),
    );
    expect((await state.load('atolis-hq', 'wake')).hookId).toBe(43);

    const failing = createGitHubWebhook(
      adapterId('github'),
      config,
      'https://new.example/',
      root,
      {
        getHook: vi.fn().mockRejectedValue({ status: 404 }),
        createHook: vi.fn().mockRejectedValue(new Error('denied')),
        updateHook: vi.fn(),
      },
      health,
    );
    await failing.provision();
    expect(health.snapshotAll().find((check) => check.channel === 'webhook')?.status).toBe(
      'degraded',
    );
  });

  it('returns the documented malformed and out-of-scope statuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-'));
    const webhook = createWebhook(root, true);
    const trigger = vi.fn();
    await expect(
      webhook.receive(
        Buffer.from('{'),
        { 'x-hub-signature-256': 'sha256=x', 'x-github-event': 'issues' },
        trigger,
      ),
    ).resolves.toBe(400);
    await expect(
      webhook.receive(
        Buffer.from(JSON.stringify({ repository: { full_name: 'other/repo' } })),
        { 'x-hub-signature-256': 'sha256=x', 'x-github-event': 'issues' },
        trigger,
      ),
    ).resolves.toBe(404);
  });

  it('retains polling when no public URL is configured and reports webhook health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-webhook-'));
    const health = createGitHubAdapterHealthRegistry([repository]);
    const config = gitHubConfigSchema.parse({
      enabled: true,
      repositories: [repository],
      webhooks: { enabled: true },
    });
    const webhook = createGitHubWebhook(
      adapterId('github'),
      config,
      undefined,
      root,
      {
        getHook: vi.fn(),
        createHook: vi.fn(),
        updateHook: vi.fn(),
      },
      health,
    );
    await webhook.provision();
    expect(health.snapshotAll().find((check) => check.channel === 'webhook')).toMatchObject({
      status: 'degraded',
      failureCount: 1,
    });
  });
});

function createWebhook(
  root: string,
  enabled: boolean,
  hooks = { getHook: vi.fn(), createHook: vi.fn(), updateHook: vi.fn() },
) {
  const config = gitHubConfigSchema.parse({
    enabled: true,
    repositories: [repository],
    webhooks: { enabled },
  });
  return createGitHubWebhook(
    adapterId('github'),
    config,
    'https://wake.example/',
    root,
    hooks,
    createGitHubAdapterHealthRegistry([repository]),
  );
}

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

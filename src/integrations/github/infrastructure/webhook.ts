import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { ProviderWebhook } from '../../contracts/provider.js';
import type { GitHubConfig } from '../contracts/config.js';
import type { GitHubAdapterHealthRegistry } from './adapter-health-registry.js';
import { GitHubWebhookStateStore } from './webhook-state.js';

const events = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'status',
]);

interface HookClient {
  getHook(owner: string, repo: string, hookId: number): Promise<void>;
  createHook(input: {
    owner: string;
    repo: string;
    url: string;
    secret: string;
    events: readonly string[];
  }): Promise<number>;
  updateHook(input: {
    owner: string;
    repo: string;
    hookId: number;
    url: string;
    secret: string;
    events: readonly string[];
  }): Promise<void>;
}

export function createGitHubWebhook(
  adapter: AdapterId,
  config: GitHubConfig,
  publicUrl: string | undefined,
  root: string,
  client: HookClient,
  health: GitHubAdapterHealthRegistry,
): ProviderWebhook {
  const state = new GitHubWebhookStateStore(root, adapter);
  const endpoint =
    publicUrl === undefined ? undefined : new URL('/webhooks/github', publicUrl).href;
  return {
    async provision() {
      for (const repository of config.repositories) {
        if (!config.webhooks.enabled) continue;
        if (endpoint === undefined) {
          health.recordFailure(
            `${repository.owner}/${repository.repo}`,
            'webhook',
            new Error('surfaces.web.publicUrl is not configured'),
          );
          continue;
        }
        await provisionRepository(repository, endpoint, state, client, health);
      }
    },
    async receive(body, headers, trigger) {
      if (!config.webhooks.enabled) return 404;
      const signature = header(headers, 'x-hub-signature-256');
      if (signature === undefined) return 401;
      const event = header(headers, 'x-github-event');
      if (event === undefined) return 400;
      const fullName = parseRepository(body);
      if (fullName === null) return 400;
      if (fullName === undefined || !events.has(event)) return 404;
      const [owner, repo] = fullName.split('/');
      if (
        owner === undefined ||
        repo === undefined ||
        !config.repositories.some((value) => value.owner === owner && value.repo === repo)
      )
        return 404;
      const saved = await state.load(owner, repo);
      const expected = `sha256=${createHmac('sha256', saved.secret).update(body).digest('hex')}`;
      if (!safeEqual(signature, expected)) return 401;
      trigger();
      return 202;
    },
  };
}

async function provisionRepository(
  repository: { readonly owner: string; readonly repo: string },
  endpoint: string,
  state: GitHubWebhookStateStore,
  client: HookClient,
  health: GitHubAdapterHealthRegistry,
): Promise<void> {
  const scope = `${repository.owner}/${repository.repo}`;
  try {
    const saved = await state.load(repository.owner, repository.repo);
    if (
      saved.hookId !== undefined &&
      (await updateManagedHook(repository, endpoint, saved, client))
    ) {
      health.recordSuccess(scope, 'webhook');
      return;
    }
    const hookId = await client.createHook({
      ...repository,
      url: endpoint,
      secret: saved.secret,
      events: [...events],
    });
    await state.save(repository.owner, repository.repo, { ...saved, hookId });
    health.recordSuccess(scope, 'webhook');
  } catch (error) {
    health.recordFailure(scope, 'webhook', error);
  }
}

async function updateManagedHook(
  repository: { readonly owner: string; readonly repo: string },
  endpoint: string,
  saved: { readonly secret: string; readonly hookId?: number },
  client: HookClient,
): Promise<boolean> {
  if (saved.hookId === undefined) return false;
  try {
    await client.getHook(repository.owner, repository.repo, saved.hookId);
    await client.updateHook({
      ...repository,
      hookId: saved.hookId,
      url: endpoint,
      secret: saved.secret,
      events: [...events],
    });
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function repositoryName(value: unknown): string | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('full_name' in value) ||
    typeof value.full_name !== 'string'
  )
    return undefined;
  return value.full_name;
}

function parseRepository(body: Buffer): string | undefined | null {
  try {
    const payload: unknown = JSON.parse(body.toString('utf8'));
    if (typeof payload !== 'object' || payload === null || !('repository' in payload)) return null;
    return repositoryName(payload.repository);
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}

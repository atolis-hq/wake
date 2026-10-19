import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { ProviderWebhook } from '../../contracts/provider.js';
import type { GitHubConfig } from '../contracts/config.js';
import type { GitHubAdapterHealthRegistry } from './adapter-health-registry.js';
import {
  WebhookOperation,
  WebhookProvisioningFailure,
  renderWebhookDiagnosis,
  webhookOperation,
} from './webhook-diagnosis.js';
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
  const endpoint = publicUrl === undefined ? undefined : webhookEndpoint(publicUrl);
  return {
    async provision() {
      for (const repository of config.repositories) {
        if (!config.webhooks.enabled) continue;
        await provisionWithDiagnosis(repository, endpoint, state, client, health);
      }
    },
    async diagnostics() {
      if (!config.webhooks.enabled) return [];
      const messages = await Promise.all(
        config.repositories.map(async ({ owner, repo }) => {
          const diagnosis =
            endpoint === undefined
              ? { operation: WebhookOperation.Configure }
              : await state.diagnosis(owner, repo);
          return diagnosis === undefined
            ? undefined
            : renderWebhookDiagnosis(owner + '/' + repo, diagnosis);
        }),
      );
      return messages.filter((message): message is string => message !== undefined);
    },
    async receive(body, headers, trigger) {
      if (!config.webhooks.enabled) return 404;
      const signature = header(headers, 'x-hub-signature-256');
      if (signature === undefined) return 401;
      const event = header(headers, 'x-github-event');
      if (event === undefined) return 400;
      const fullName = parseRepository(body);
      if (fullName === null) return 400;
      if (fullName === undefined) return 404;
      const [owner, repo] = fullName.split('/');
      if (
        owner === undefined ||
        repo === undefined ||
        !config.repositories.some((value) => value.owner === owner && value.repo === repo)
      )
        return 404;
      return state.serialise(owner, repo, async () => {
        const saved = await state.load(owner, repo);
        const expected = `sha256=${createHmac('sha256', saved.secret).update(body).digest('hex')}`;
        if (!safeEqual(signature, expected)) return 401;
        if (!events.has(event)) return 404;
        // A signed delivery proves ingress works, even if auto-provisioning failed
        // earlier (e.g. a manually configured hook), so it supersedes that diagnosis.
        if (saved.diagnosis !== undefined) {
          const { diagnosis: _diagnosis, ...rest } = saved;
          await state.save(owner, repo, rest);
        }
        health.recordSuccess(`${owner}/${repo}`, 'webhook');
        trigger();
        return 202;
      });
    },
    async setupInstructions() {
      if (!config.webhooks.enabled || endpoint === undefined) return [];
      return Promise.all(
        config.repositories.map(({ owner, repo }) =>
          state.serialise(owner, repo, async () => ({
            scope: `${owner}/${repo}`,
            endpoint,
            events: [...events],
            secret: (await state.load(owner, repo)).secret,
          })),
        ),
      );
    },
  };
}

async function provisionWithDiagnosis(
  repository: { readonly owner: string; readonly repo: string },
  endpoint: string | undefined,
  state: GitHubWebhookStateStore,
  client: HookClient,
  health: GitHubAdapterHealthRegistry,
): Promise<void> {
  const scope = repository.owner + '/' + repository.repo;
  try {
    await state.serialise(repository.owner, repository.repo, async () => {
      try {
        if (endpoint === undefined)
          throw new WebhookProvisioningFailure({ operation: WebhookOperation.Configure });
        await provisionRepository(repository, endpoint, state, client);
        const { diagnosis: _diagnosis, ...saved } = await state.load(
          repository.owner,
          repository.repo,
        );
        await state.save(repository.owner, repository.repo, saved);
        health.recordSuccess(scope, 'webhook');
      } catch (error) {
        const diagnosis =
          error instanceof WebhookProvisioningFailure
            ? error.diagnosis
            : { operation: WebhookOperation.State };
        const message = renderWebhookDiagnosis(scope, diagnosis);
        const saved = await state.load(repository.owner, repository.repo);
        await state.save(repository.owner, repository.repo, { ...saved, diagnosis });
        health.recordFailure(scope, 'webhook', new Error(message));
        process.stderr.write(message + '\n');
      }
    });
  } catch {
    // Unavailable provider state must not prevent polling from starting.
    const message = renderWebhookDiagnosis(scope, { operation: WebhookOperation.State });
    health.recordFailure(scope, 'webhook', new Error(message));
    process.stderr.write(message + '\n');
  }
}

async function provisionRepository(
  repository: { readonly owner: string; readonly repo: string },
  endpoint: string,
  state: GitHubWebhookStateStore,
  client: HookClient,
): Promise<void> {
  const saved = await state.load(repository.owner, repository.repo);
  if (
    saved.hookId !== undefined &&
    (await updateManagedHook(repository, endpoint, saved, client))
  ) {
    return;
  }
  const hookId = await webhookOperation(WebhookOperation.Create, () =>
    client.createHook({
      ...repository,
      url: endpoint,
      secret: saved.secret,
      events: [...events],
    }),
  );
  await state.save(repository.owner, repository.repo, { ...saved, hookId });
}

async function updateManagedHook(
  repository: { readonly owner: string; readonly repo: string },
  endpoint: string,
  saved: { readonly secret: string; readonly hookId?: number },
  client: HookClient,
): Promise<boolean> {
  const hookId = saved.hookId;
  if (hookId === undefined) return false;
  try {
    await webhookOperation(WebhookOperation.Read, () =>
      client.getHook(repository.owner, repository.repo, hookId),
    );
    await webhookOperation(WebhookOperation.Update, () =>
      client.updateHook({
        ...repository,
        hookId,
        url: endpoint,
        secret: saved.secret,
        events: [...events],
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof WebhookProvisioningFailure &&
      error.diagnosis.operation === WebhookOperation.Read &&
      error.diagnosis.status === 404
    )
      return false;
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

function webhookEndpoint(publicUrl: string): string {
  const base = new URL(publicUrl);
  base.pathname = `${base.pathname.replace(/\/$/, '')}/webhooks/github`;
  base.search = '';
  base.hash = '';
  return base.href;
}

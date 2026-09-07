import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterId } from '../../contracts/identifiers.js';

export interface GitHubWebhookState {
  readonly secret: string;
  readonly hookId?: number;
}

/** Provider operational state: intentionally outside configuration and projections. */
export class GitHubWebhookStateStore {
  constructor(
    private readonly root: string,
    private readonly adapter: AdapterId,
  ) {}

  async load(owner: string, repo: string): Promise<GitHubWebhookState> {
    const path = this.path(owner, repo);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'secret' in parsed &&
        typeof parsed.secret === 'string' &&
        ('hookId' in parsed ? typeof parsed.hookId === 'number' : true)
      )
        return parsed as GitHubWebhookState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const state = { secret: randomBytes(32).toString('hex') };
    await this.save(owner, repo, state);
    return state;
  }

  async save(owner: string, repo: string, state: GitHubWebhookState): Promise<void> {
    const path = this.path(owner, repo);
    await mkdir(join(this.root, 'github-webhooks', this.adapter), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  private path(owner: string, repo: string): string {
    return join(
      this.root,
      'github-webhooks',
      this.adapter,
      `${encodeURIComponent(owner)}--${encodeURIComponent(repo)}.json`,
    );
  }
}

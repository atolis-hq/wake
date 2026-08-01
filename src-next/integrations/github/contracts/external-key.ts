import { z } from 'zod';

export interface GitHubResourceLocator {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const keyPattern = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

export function formatGitHubResourceKey(locator: GitHubResourceLocator): string {
  return `${locator.owner}/${locator.repo}#${locator.number}`;
}

export function parseGitHubResourceKey(key: string): GitHubResourceLocator {
  const matched = keyPattern.exec(key);
  if (matched === null) throw new Error(`Invalid GitHub resource key: ${key}`);
  const parsed = z.coerce.number<string>().int().positive().safeParse(matched[3]);
  if (!parsed.success)
    throw new Error(`Invalid GitHub resource key: ${key}`, { cause: parsed.error });
  return { owner: matched[1]!, repo: matched[2]!, number: parsed.data };
}

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolveWakeVersionOptions {
  readonly repoRoot?: string;
  readonly gitOutput?: (args: readonly string[]) => string;
}

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitOutputFromRoot(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args as string[], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Mirrors legacy src/version.ts: exact tag at HEAD, else latest tag + short hash, else
// short hash, else a dev placeholder. Packaged installs get a literal value baked in at
// build time by scripts/embed-version.mjs, so the git plumbing here only runs from source.
export function resolveWakeVersion(options: ResolveWakeVersionOptions = {}): string {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const gitOutput = options.gitOutput ?? ((args) => gitOutputFromRoot(repoRoot, args));
  const exactTag = gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
  if (exactTag.length > 0) return exactTag;

  const latestTag = gitOutput(['describe', '--tags', '--abbrev=0']);
  const shortHash = gitOutput(['rev-parse', '--short', 'HEAD']);
  if (latestTag.length > 0 && shortHash.length > 0) return `${latestTag}+g${shortHash}`;
  if (shortHash.length > 0) return `g${shortHash}`;

  return '0.1.0-dev';
}

export const wakeVersion = resolveWakeVersion();

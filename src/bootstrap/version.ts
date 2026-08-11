import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReadTextFile = (path: string) => string | undefined;

export type ListTextFiles = (path: string) => Array<{ path: string; content: string }>;

export interface ResolveWakeVersionOptions {
  readonly repoRoot?: string;
  readonly gitOutput?: (args: readonly string[]) => string;
  readonly readTextFile?: ReadTextFile;
  readonly listTextFiles?: ListTextFiles;
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

function defaultReadTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultListTextFiles(path: string): Array<{ path: string; content: string }> {
  if (!existsSync(path)) return [];
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...defaultListTextFiles(entryPath));
    else if (entry.isFile()) {
      const content = defaultReadTextFile(entryPath);
      if (content !== undefined) files.push({ path: entryPath, content });
    }
  }
  return files;
}

function currentHeadHash(repoRoot: string, readTextFile: ReadTextFile): string {
  const head = readTextFile(resolve(repoRoot, '.git', 'HEAD'))?.trim();
  if (head === undefined || head.length === 0) return '';
  if (!head.startsWith('ref: ')) return head;
  return (
    readTextFile(
      resolve(repoRoot, '.git', ...head.slice('ref: '.length).trim().split('/')),
    )?.trim() ?? ''
  );
}

function exactTagFromGitFiles(
  repoRoot: string,
  readTextFile: ReadTextFile,
  listTextFiles: ListTextFiles,
): string {
  const headHash = currentHeadHash(repoRoot, readTextFile);
  if (headHash.length === 0) return '';
  const tagsRoot = resolve(repoRoot, '.git', 'refs', 'tags');
  const root = tagsRoot.replaceAll('\\', '/');
  const looseTags = listTextFiles(tagsRoot).map((file) => ({
    name: file.path.replaceAll('\\', '/').slice(root.length + 1),
    hash: file.content.trim(),
  }));
  return (
    [...looseTags, ...packedTagRefs(repoRoot, readTextFile)].find((tag) => tag.hash === headHash)
      ?.name ?? ''
  );
}

function packedTagRefs(
  repoRoot: string,
  readTextFile: ReadTextFile,
): Array<{ name: string; hash: string }> {
  const packedRefs = readTextFile(resolve(repoRoot, '.git', 'packed-refs'));
  if (packedRefs === undefined) return [];
  const tags: Array<{ name: string; hash: string }> = [];
  let precedingTag: { name: string; hash: string } | undefined;
  for (const line of packedRefs.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('^')) {
      if (precedingTag !== undefined) precedingTag.hash = line.slice(1).trim();
      continue;
    }
    precedingTag = undefined;
    const [hash, ref] = line.split(' ');
    if (hash !== undefined && ref?.startsWith('refs/tags/') === true) {
      precedingTag = { name: ref.slice('refs/tags/'.length), hash };
      tags.push(precedingTag);
    }
  }
  return tags;
}

// Mirrors legacy src/version.ts: exact tag at HEAD, else latest tag + short hash, else
// short hash, else a dev placeholder. Packaged installs get a literal value baked in at
// build time by scripts/embed-version.mjs, so the git plumbing here only runs from source.
export function resolveWakeVersion(options: ResolveWakeVersionOptions = {}): string {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const gitOutput = options.gitOutput ?? ((args) => gitOutputFromRoot(repoRoot, args));
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const listTextFiles = options.listTextFiles ?? defaultListTextFiles;
  const exactTag = gitOutput(['describe', '--tags', '--exact-match', 'HEAD']);
  if (exactTag.length > 0) return exactTag;

  const exactFileTag = exactTagFromGitFiles(repoRoot, readTextFile, listTextFiles);
  if (exactFileTag.length > 0) return exactFileTag;

  const latestTag = gitOutput(['describe', '--tags', '--abbrev=0']);
  const shortHash = gitOutput(['rev-parse', '--short', 'HEAD']);
  if (latestTag.length > 0 && shortHash.length > 0) return `${latestTag}+g${shortHash}`;
  if (shortHash.length > 0) return `g${shortHash}`;

  const headHash = currentHeadHash(repoRoot, readTextFile);
  if (headHash.length > 0) return `g${headHash.slice(0, 7)}`;

  return '0.1.0-dev';
}

export const wakeVersion = resolveWakeVersion();

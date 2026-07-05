import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PromptTemplate {
  frontmatter: Record<string, string>;
  body: string;
}

function findProjectRoot(startDir: string): string {
  let dir = startDir;

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  throw new Error(`Could not locate project root above ${startDir}`);
}

function parseFrontmatter(raw: string): PromptTemplate {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (match === null) {
    return { frontmatter: {}, body: raw };
  }

  const [, frontmatterBlock, body] = match;
  const frontmatter: Record<string, string> = {};

  for (const line of (frontmatterBlock ?? '').split(/\r?\n/)) {
    const lineMatch = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (lineMatch === null) {
      continue;
    }

    const [, key, value] = lineMatch;
    if (key !== undefined) {
      frontmatter[key] = (value ?? '').trim();
    }
  }

  return { frontmatter, body: body ?? '' };
}

export function promptsRoot(): string {
  return join(findProjectRoot(dirname(fileURLToPath(import.meta.url))), 'prompts');
}

export async function loadPromptTemplate(
  stage: string,
  mode: string,
): Promise<PromptTemplate> {
  const filePath = join(promptsRoot(), `${stage}.${mode}.md`);
  const raw = await readFile(filePath, 'utf8');
  return parseFrontmatter(raw);
}

export function renderPromptTemplate(
  template: PromptTemplate,
  context: Record<string, unknown>,
): string {
  return template.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (fullMatch, token: string) => {
    if (!(token in context)) {
      return fullMatch;
    }

    const value = context[token];
    if (value === undefined) {
      return '';
    }

    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}

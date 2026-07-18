import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

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

export function promptsRoot(explicitRoot?: string): string {
  return explicitRoot ?? join(findProjectRoot(dirname(fileURLToPath(import.meta.url))), 'prompts');
}

export async function loadPromptTemplate(
  stage: string,
  mode: string,
  options?: {
    promptsRoot?: string;
  },
): Promise<PromptTemplate> {
  const root = promptsRoot(options?.promptsRoot);
  const combinedFilePath = join(root, `${stage}.md`);
  const modeFilePath = join(root, `${stage}.${mode}.md`);

  let raw: string;
  try {
    raw = await readFile(combinedFilePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }

    raw = await readFile(modeFilePath, 'utf8');
  }

  return parseFrontmatter(raw);
}

export function renderPromptTemplate(
  template: PromptTemplate,
  context: Record<string, unknown>,
): string {
  const renderContext = Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, Object.assign([...value], { toString: () => JSON.stringify(value, null, 2) })];
      }

      if (value !== null && typeof value === 'object') {
        return [
          key,
          Object.assign({ ...value }, { toString: () => JSON.stringify(value, null, 2) }),
        ];
      }

      return [key, value];
    }),
  );
  const compiled = Handlebars.compile(template.body, {
    noEscape: true,
  });

  return compiled(renderContext);
}

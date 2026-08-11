import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const frontmatterSchema = z
  .object({
    model: z.string().trim().min(1).nullable().optional(),
    maxTurns: z.number().int().positive().optional(),
    allowedTools: z.array(z.string().trim().min(1)).nullable().optional(),
    extraArgs: z.array(z.string()).nullable().optional(),
  })
  .strict();

export interface PromptTemplate {
  readonly name: string;
  readonly body: string;
  readonly frontmatter: z.infer<typeof frontmatterSchema>;
}

export function renderPromptTemplate(
  template: PromptTemplate,
  context: Readonly<Record<string, unknown>>,
): string {
  return Handlebars.compile(template.body, { noEscape: true, strict: true })(context);
}

export async function loadPromptTemplate(wakeRoot: string, name: string): Promise<PromptTemplate> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`Invalid prompt template name: ${name}`);
  const path = join(wakeRoot, 'prompts', `${name}.md`);
  const source = await readFile(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)---\r?\n?([\s\S]*)$/u.exec(source);
  if (match === null) throw new Error(`Prompt template ${path} must start with YAML frontmatter`);
  const [, frontmatterSource, body] = match;
  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatterSource!);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown YAML parsing failure';
    throw new Error(`Prompt template ${path} frontmatter is invalid: ${message}`, { cause: error });
  }
  const validated = frontmatterSchema.safeParse(parsed ?? {});
  if (!validated.success) {
    const details = validated.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Prompt template ${path} frontmatter is invalid: ${details}`);
  }
  return { name, body: body!.trim(), frontmatter: validated.data };
}

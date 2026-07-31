import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { parseRootConfig, type ResolvedWakeModulesConfig } from './root-schema.js';
export type { ResolvedWakeModulesConfig } from './root-schema.js';

export async function loadConfig(wakeRoot: string): Promise<ResolvedWakeModulesConfig> {
  const main = await readYaml(join(wakeRoot, 'config.yaml'));
  const workflows = await readYamlIfPresent(join(wakeRoot, 'config.workflows.yaml'));
  const merged = merge(main, workflows === undefined ? {} : normalizeWorkflowFile(workflows));
  try {
    return parseRootConfig(merged);
  } catch (error) {
    if (error instanceof Error && 'issues' in error) {
      const issues = (
        error as { issues: readonly { path: readonly (string | number)[]; message: string }[] }
      ).issues;
      throw new Error(
        `Configuration validation failed: ${issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function readYaml(path: string): Promise<unknown> {
  return YAML.parse(await readFile(path, 'utf8')) ?? {};
}

async function readYamlIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return await readYaml(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function normalizeWorkflowFile(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return 'workflows' in record
    ? { orchestration: record }
    : { orchestration: { workflows: record } };
}

function merge(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return right;
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right))
    result[key] = key in result ? merge(result[key], value) : value;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { resolve } from 'node:path';
import { access } from 'node:fs/promises';

import { readJsonFile } from '../lib/json-file.js';
import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

export async function loadWakeConfig(options?: {
  wakeRoot?: string;
  configFile?: string;
}): Promise<WakeConfig> {
  const wakeRoot = options?.wakeRoot ?? resolve(process.cwd(), '.wake');
  const configFile = options?.configFile;

  let raw: Record<string, unknown> = {};

  if (configFile !== undefined) {
    try {
      await access(configFile);
      raw = await readJsonFile<Record<string, unknown>>(configFile);
    } catch {
      // no config file — schema defaults apply
    }
  }

  const rawPaths = (raw.paths as Record<string, unknown> | undefined) ?? {};
  return parseWakeConfig({
    ...raw,
    paths: {
      wakeRoot,
      ...rawPaths,
    },
  });
}

import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';

import { readJsonFile } from '../lib/json-file.js';
import { readYamlFile } from '../lib/yaml-file.js';
import { deepMergeRaw } from '../lib/deep-merge.js';
import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';
import { discoverConfigFiles } from './discover-config-files.js';

async function readLegacyConfigIfPresent(wakeRoot: string): Promise<Record<string, unknown>> {
  const legacyConfigFile = join(wakeRoot, 'config.json');
  try {
    await access(legacyConfigFile);
  } catch {
    return {};
  }
  return readJsonFile<Record<string, unknown>>(legacyConfigFile);
}

export async function loadWakeConfig(options?: { wakeRoot?: string }): Promise<WakeConfig> {
  const wakeRoot = options?.wakeRoot ?? resolve(process.cwd(), '.wake');

  const configFiles = await discoverConfigFiles(wakeRoot);

  let raw: Record<string, unknown>;
  if (configFiles.length > 0) {
    raw = {};
    for (const configFile of configFiles) {
      raw = deepMergeRaw(raw, await readYamlFile<Record<string, unknown>>(configFile));
    }
  } else {
    // Pre-split Wake homes only have a single config.json — Wake reads it
    // directly rather than requiring a migration step. It stays untouched
    // on disk; nothing here writes it back out (see docs/configuration.md).
    raw = await readLegacyConfigIfPresent(wakeRoot);
  }

  // wakeRoot is always the live invocation's --wake-root/cwd, never a value
  // to accept from a (possibly stale, possibly container-context) config
  // file — spread rawPaths first so wakeRoot always wins. promptsRoot and
  // any other paths key stay file-overridable.
  const rawPaths = (raw.paths as Record<string, unknown> | undefined) ?? {};
  return parseWakeConfig({
    ...raw,
    paths: {
      ...rawPaths,
      wakeRoot,
    },
  });
}

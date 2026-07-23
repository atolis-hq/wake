import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';

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
      let parsed: Record<string, unknown>;
      try {
        // yaml.parse returns null for empty/comment-only files rather than
        // {}, so coalesce before merging.
        parsed = (await readYamlFile<Record<string, unknown>>(configFile)) ?? {};
      } catch (error) {
        throw new Error(`Failed to parse ${configFile}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      raw = deepMergeRaw(raw, parsed);
    }
  } else {
    // Pre-split Wake homes only have a single config.json — Wake reads it
    // directly rather than requiring a migration step. It stays untouched
    // on disk; nothing here writes it back out (see docs/configuration.md).
    raw = await readLegacyConfigIfPresent(wakeRoot);
  }

  // wakeRoot is always the live invocation's --wake-root/cwd, never a value
  // to accept from a (possibly stale, possibly container-context) config
  // file — spread rawPaths first so wakeRoot always wins. promptsRoot stays
  // file-overridable for a genuine custom location, but when the file is
  // silent on it we default to the live wakeRoot's own prompts/ dir (the
  // usual colocated layout `wake init` scaffolds) rather than leaving it to
  // fall back to bundled prompts — this keeps a scaffolded home's prompt
  // customizations in effect across host/container re-reads of the same
  // config file, where an absolute promptsRoot baked in at init time would
  // not resolve the same way.
  const rawPaths = (raw.paths as Record<string, unknown> | undefined) ?? {};
  const wakeRootPromptsDir = join(wakeRoot, 'prompts');
  const promptsRootDefault =
    rawPaths.promptsRoot === undefined && existsSync(wakeRootPromptsDir)
      ? { promptsRoot: wakeRootPromptsDir }
      : {};
  return parseWakeConfig({
    ...raw,
    paths: {
      ...rawPaths,
      ...promptsRootDefault,
      wakeRoot,
    },
  });
}

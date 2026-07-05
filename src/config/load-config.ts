import { access } from 'node:fs/promises';

import { createDefaultWakeConfig } from './defaults.js';
import { readJsonFile } from '../lib/json-file.js';
import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

function mergeWakeConfig(base: WakeConfig, loaded: Record<string, unknown>): WakeConfig {
  const next = loaded as Partial<WakeConfig>;

  return parseWakeConfig({
    ...base,
    ...next,
    paths: {
      ...base.paths,
      ...(next.paths ?? {}),
    },
    scheduler: {
      ...base.scheduler,
      ...(next.scheduler ?? {}),
    },
    runner: {
      ...base.runner,
      ...(next.runner ?? {}),
      claude: {
        ...base.runner.claude,
        ...(next.runner?.claude ?? {}),
      },
    },
    sources: {
      ...base.sources,
      ...(next.sources ?? {}),
      github: {
        ...base.sources.github,
        ...(next.sources?.github ?? {}),
        polling: {
          ...base.sources.github.polling,
          ...(next.sources?.github?.polling ?? {}),
        },
        policy: {
          ...base.sources.github.policy,
          ...(next.sources?.github?.policy ?? {}),
        },
        publication: {
          ...base.sources.github.publication,
          ...(next.sources?.github?.publication ?? {}),
        },
      },
    },
  });
}

export async function loadWakeConfig(options?: {
  wakeRoot?: string;
  configFile?: string;
}): Promise<WakeConfig> {
  const baseConfig = createDefaultWakeConfig(options?.wakeRoot);
  const configFile = options?.configFile;

  if (configFile === undefined) {
    return baseConfig;
  }

  try {
    await access(configFile);
  } catch {
    return baseConfig;
  }

  const raw = await readJsonFile<Record<string, unknown>>(configFile);
  return mergeWakeConfig(baseConfig, raw);
}

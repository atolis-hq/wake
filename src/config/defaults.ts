import { resolve } from 'node:path';

import { defaultAgentIdentity, defaultSmokePrompt, parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

export { defaultAgentIdentity, defaultSmokePrompt };

export function createDefaultWakeConfig(wakeRoot = resolve(process.cwd(), '.wake')): WakeConfig {
  return parseWakeConfig({
    paths: {
      wakeRoot,
      promptsRoot: resolve(wakeRoot, 'prompts'),
    },
  });
}

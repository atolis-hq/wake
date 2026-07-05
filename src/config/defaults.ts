import { resolve } from 'node:path';

import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

export const defaultSmokePrompt = 'This is Eddy, reply with "hi Eddy only"';

export function createDefaultWakeConfig(wakeRoot = resolve(process.cwd(), '.wake')): WakeConfig {
  return parseWakeConfig({
    schemaVersion: 1,
    paths: {
      wakeRoot,
    },
    scheduler: {
      intervalMs: 30 * 60 * 1000,
    },
    runner: {
      mode: 'fake',
      claude: {
        command: 'claude',
        model: 'haiku',
        smokeModel: 'haiku',
        sessionName: 'Eddy',
        remoteControlName: 'Eddy',
        smokePrompt: defaultSmokePrompt,
      },
    },
    sources: {
      github: {
        enabled: false,
        repos: [],
        polling: {
          maxIssuesPerRepo: 25,
          commentPageSize: 25,
          lookbackMs: 60_000,
        },
        policy: {
          requiredLabels: [],
          ignoredLabels: [],
        },
        publication: {
          postStatusComments: true,
        },
      },
    },
  });
}

import { resolve } from 'node:path';

import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

export const defaultSmokePrompt = 'This is Eddy, reply with "hi Eddy only"';

export function createDefaultWakeConfig(wakeRoot = resolve(process.cwd(), '.wake')): WakeConfig {
  return parseWakeConfig({
    schemaVersion: 1,
    paths: {
      wakeRoot,
      promptsRoot: resolve(wakeRoot, 'prompts'),
    },
    sandbox: {
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [],
    },
    dev: {},
    scheduler: {
      intervalMs: 60 * 1000,
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
        timeoutMs: 30 * 60 * 1000,
        remoteControl: {
          enabled: false,
        },
        models: {
          default: 'haiku',
          implement: 'claude-sonnet-4-6',
        },
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
          requiredAssignees: [],
        },
        publication: {
          postStatusComments: true,
        },
      },
    },
  });
}

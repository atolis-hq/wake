import { wakeInfraConfigSchema, wakeWorkflowConfigSchema } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

const infraKeys = Object.keys(wakeInfraConfigSchema.shape) as (keyof WakeConfig)[];
const workflowKeys = Object.keys(wakeWorkflowConfigSchema.shape) as (keyof WakeConfig)[];

export function splitWakeConfig(config: WakeConfig): {
  infra: Record<string, unknown>;
  workflow: Record<string, unknown>;
} {
  const infra: Record<string, unknown> = {};
  for (const key of infraKeys) {
    infra[key] = config[key];
  }

  const workflow: Record<string, unknown> = {};
  for (const key of workflowKeys) {
    workflow[key] = config[key];
  }

  return { infra, workflow };
}

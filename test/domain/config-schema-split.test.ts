import { describe, expect, it } from 'vitest';

import {
  wakeConfigSchema,
  wakeInfraConfigSchema,
  wakeWorkflowConfigSchema,
} from '../../src/domain/schema.js';

describe('wakeConfigSchema split', () => {
  it('partitions every top-level config key into exactly one of infra or workflow', () => {
    // zod v4: superRefine adds a check in place on the ZodObject rather than
    // wrapping it in an effects type, so the shape is available directly.
    const allKeys = Object.keys(wakeConfigSchema.shape);
    const infraKeys = new Set(Object.keys(wakeInfraConfigSchema.shape));
    const workflowKeys = new Set(Object.keys(wakeWorkflowConfigSchema.shape));

    for (const key of allKeys) {
      const inInfra = infraKeys.has(key);
      const inWorkflow = workflowKeys.has(key);
      expect(inInfra || inWorkflow, `key "${key}" must be in exactly one sub-schema`).toBe(true);
      expect(inInfra && inWorkflow, `key "${key}" must not be in both sub-schemas`).toBe(false);
    }

    expect(infraKeys.size + workflowKeys.size).toBe(allKeys.length);
  });

  it('keeps runners/tiers/workflows/commands/stages together in the workflow schema', () => {
    const workflowKeys = Object.keys(wakeWorkflowConfigSchema.shape).sort();
    expect(workflowKeys).toEqual(
      [
        'commands',
        'defaultTier',
        'runners',
        'stages',
        'tiers',
        'workflowSelectors',
        'workflows',
      ].sort(),
    );
  });

  it('keeps paths/sandbox/sources/ui together in the infra schema', () => {
    const infraKeys = Object.keys(wakeInfraConfigSchema.shape).sort();
    expect(infraKeys).toEqual(
      [
        'dev',
        'paths',
        'sandbox',
        'schemaVersion',
        'scheduler',
        'sinks',
        'sources',
        'transcripts',
        'ui',
      ].sort(),
    );
  });
});

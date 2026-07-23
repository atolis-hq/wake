import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { splitWakeConfig } from '../../src/config/split-config.js';

describe('splitWakeConfig', () => {
  it('puts sandbox/sources/paths in infra and runners/workflows in workflow', () => {
    const config = createDefaultWakeConfig('/tmp/wake-home');

    const { infra, workflow } = splitWakeConfig(config);

    expect(infra).toHaveProperty('sandbox');
    expect(infra).toHaveProperty('sources');
    expect(infra).toHaveProperty('paths');
    expect(infra).not.toHaveProperty('runners');
    expect(infra).not.toHaveProperty('workflows');

    expect(workflow).toHaveProperty('runners');
    expect(workflow).toHaveProperty('workflows');
    expect(workflow).toHaveProperty('tiers');
    expect(workflow).not.toHaveProperty('sandbox');
    expect(workflow).not.toHaveProperty('paths');
  });

  it('preserves the actual values, not just the keys', () => {
    const config = createDefaultWakeConfig('/tmp/wake-home');

    const { infra, workflow } = splitWakeConfig(config);

    expect(infra.sandbox).toEqual(config.sandbox);
    expect(workflow.defaultTier).toBe(config.defaultTier);
  });
});

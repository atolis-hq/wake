import { describe, expect, it } from 'vitest';

import { createLifecycleService } from '../../src/core/lifecycle-service.js';

describe('lifecycle service', () => {
  it.each(['refine', 'implement'] as const)(
    'keeps the current stage when a %s action fails',
    (action) => {
      const lifecycle = createLifecycleService();

      expect(lifecycle.nextStageFromSentinel(action, 'FAILED')).toBeNull();
    },
  );

  it.each(['refine', 'implement'] as const)(
    'keeps the current stage when a %s action blocks',
    (action) => {
      const lifecycle = createLifecycleService();

      expect(lifecycle.nextStageFromSentinel(action, 'BLOCKED')).toBeNull();
    },
  );
});

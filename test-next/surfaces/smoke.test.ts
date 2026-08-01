import { describe, expect, it } from 'vitest';
import { runSmoke } from '../../src-next/surfaces/cli/commands/smoke.js';

describe('smoke', () => {
  it('uses the injected target runner', async () => {
    await expect(runSmoke({ run: async () => ({ ok: true }) })).resolves.toEqual({ ok: true });
  });
});

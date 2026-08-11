import { describe, expect, it } from 'vitest';
import { runSmoke } from '../../../src/surfaces/cli/commands/smoke.js';

describe('smoke', () => {
  it('uses the injected target runner', async () => {
    await expect(runSmoke({ run: async () => ({ ok: true }) })).resolves.toEqual({ ok: true });
  });
});

it('starts the configured target Runner and reports its actual transport outcome', async () => {
  const { runTargetSmoke } = await import('../../../src/surfaces/cli/commands/smoke.js');
  const requests: unknown[] = [];
  const result = await runTargetSmoke(
    {
      resolve: () => ({
        name: 'fake',
        runner: {
          start: async (request: unknown) => {
            requests.push(request);
            return {
              cancel: async () => undefined,
              result: Promise.resolve({
                transport: 'succeeded',
                output: '{"status":"DONE"}',
                runner: 'fake',
              }),
            };
          },
        },
      }),
    },
    'standard',
    new AbortController().signal,
  );
  expect(requests).toHaveLength(1);
  expect(result).toMatchObject({ ok: true, runner: 'fake', transport: 'succeeded' });
});

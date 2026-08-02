import { describe, expect, it } from 'vitest';
import { createDockerCli } from '../../src-next/surfaces/cli/infrastructure/docker-cli.js';
import { scrubProcessLog } from '../../src-next/surfaces/cli/infrastructure/process-log.js';

describe('CLI infrastructure', () => {
  it('delegates Docker invocation through its injected process boundary', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli(async (arguments_) => {
      calls.push([...arguments_]);
    });

    await docker.invoke(['ps']);

    expect(calls).toEqual([['ps']]);
  });

  it('scrubs supported secret-shaped process output', () => {
    expect(scrubProcessLog('token=abc secret=def password=ghi key=jkl ok=value')).toBe(
      'token=[REDACTED] secret=[REDACTED] password=[REDACTED] key=[REDACTED] ok=value',
    );
  });
});

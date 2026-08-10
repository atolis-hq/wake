import { expect } from 'vitest';
import { main } from '../../../src-next/main.js';
import { defineScenario } from '../support/scenario.js';

defineScenario(
  {
    id: 'E2E-OPS-SANDBOX-001',
    title: 'the public CLI forwards a runtime command into the configured sandbox',
    given: ['a Wake root with a sandbox Dockerfile'],
    when: ['an operator invokes tick with that root'],
    then: ['the sandbox receives the command with its container-local Wake root and bypass flag'],
  },
  async () => {
    const forwarded: { wakeRoot?: string; arguments_?: readonly string[] } = {};

    await main(['tick', '--wake-root', 'C:/operator/wake'], {
      compose: async () => {
        throw new Error('sandbox delegation must precede composition');
      },
      sandboxRuntime: {
        async hasDockerfile(wakeRoot) {
          forwarded.wakeRoot = wakeRoot;
          return true;
        },
        async exec(_wakeRoot, arguments_) {
          forwarded.arguments_ = arguments_;
        },
      },
      output: { write() {} },
      signal: new AbortController().signal,
    });

    expect(forwarded).toEqual({
      wakeRoot: 'C:/operator/wake',
      arguments_: ['tick', '--wake-root', '/wake', '--no-sandbox'],
    });
  },
);

import { describe, expect, it } from 'vitest';

import {
  buildClaudePrintArgs,
  buildClaudeRemoteControlArgs,
} from '../../src/adapters/claude/claude-runner.js';
import { defaultSmokePrompt } from '../../src/config/defaults.js';

describe('claude runner command building', () => {
  it('builds a minimal haiku print invocation for smoke tests', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      sessionName: 'Eddy',
    });

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('builds a remote-control smoke invocation', () => {
    const args = buildClaudeRemoteControlArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      remoteControlName: 'Eddy',
      sessionName: 'Eddy',
    });

    expect(args).toContain('--remote-control');
    expect(args).toContain('--bg');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });
});

import { describe, expect, it } from 'vitest';
import { buildResumeCommandForCli } from '../../../src/surfaces/cli/infrastructure/sandbox-resume-command.js';

describe('sandbox resume command', () => {
  it.each([
    ['claude', ['claude', '--resume', 's1']],
    ['codex', ['codex', 'exec', 'resume', 's1']],
    ['cursor', ['cursor', 'agent', '--resume=s1']],
    ['copilot', ['copilot', '--resume=s1']],
    ['  Copilot ', ['copilot', '--resume=s1']],
  ])('builds the resume command for %j', (cli, expected) => {
    expect(buildResumeCommandForCli(cli, 's1')).toEqual(expected);
  });

  it.each(['unknown', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'returns null for the unsupported CLI name %j',
    (cli) => {
      expect(buildResumeCommandForCli(cli, 's1')).toBeNull();
    },
  );
});

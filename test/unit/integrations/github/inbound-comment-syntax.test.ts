import { describe, expect, it } from 'vitest';
import {
  isPlainReply,
  recognizedCommand,
} from '../../../../src/integrations/github/application/inbound-comment-syntax.js';
import { GitHubBuiltInCommand } from '../../../../src/integrations/github/contracts/vocabulary.js';

describe('recognizedCommand', () => {
  it.each([
    ['/changes', GitHubBuiltInCommand.Changes],
    ['/changes please fix the error handling', GitHubBuiltInCommand.Changes],
    ['/changes\tplease fix the error handling', GitHubBuiltInCommand.Changes],
    ['/changes\n\nplease fix the error handling', GitHubBuiltInCommand.Changes],
    ['/changes\r\n\r\nplease fix the error handling', GitHubBuiltInCommand.Changes],
    ['  /Changes  \n\nfeedback below', GitHubBuiltInCommand.Changes],
    ['/approved', GitHubBuiltInCommand.Approved],
    ['/approved\n\nthanks!', GitHubBuiltInCommand.Approved],
    ['/retry', GitHubBuiltInCommand.Retry],
    ['/retry\n\nplease', GitHubBuiltInCommand.Retry],
  ])('recognizes %j as %s', (body, expected) => {
    expect(recognizedCommand(body)).toBe(expected);
  });

  it.each([['/ask a question'], ['/changesomething'], ['not a command'], ['']])(
    'returns null for %j',
    (body) => {
      expect(recognizedCommand(body)).toBeNull();
    },
  );
});

describe('isPlainReply', () => {
  it('treats a recognized command with trailing blank-line feedback as not a plain reply', () => {
    expect(isPlainReply('/changes\n\nplease fix the error handling')).toBe(false);
  });

  it('treats freeform text as a plain reply', () => {
    expect(isPlainReply('please fix the error handling')).toBe(true);
  });
});

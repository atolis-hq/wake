import { describe, expect, it } from 'vitest';
import {
  conversationCommand,
  resolveSurfaceCapabilities,
} from '../../../src/orchestration/index.js';

describe('conversation command policy', () => {
  it('uses conservative defaults and permits explicit additive or replacement overrides', () => {
    expect(resolveSurfaceCapabilities('github', undefined, ['review-surface'])).toEqual([
      'review-surface',
    ]);
    expect(resolveSurfaceCapabilities('slack', undefined)).toEqual([]);
    expect(
      resolveSurfaceCapabilities('slack', {
        capabilities: { slack: ['chat-surface'] },
        replace: false,
      }),
    ).toEqual(['chat-surface']);
    expect(
      resolveSurfaceCapabilities(
        'github',
        { capabilities: { github: ['chat-surface'] }, replace: true },
        ['review-surface'],
      ),
    ).toEqual(['chat-surface']);
  });

  it('matches only the first trimmed line and ignores arguments', () => {
    expect(conversationCommand('  /approved because it looks good\nMore detail')).toBe('/approved');
    expect(conversationCommand('/retry\tplease')).toBe('/retry');
    expect(conversationCommand('a reply with /approved')).toBeNull();
  });
});

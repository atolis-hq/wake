import { describe, expect, it } from 'vitest';
import { conversationCommand } from '../../../src/orchestration/index.js';

describe('conversation command policy', () => {
  it('matches only the first trimmed line and ignores arguments', () => {
    expect(conversationCommand('  /approved because it looks good\nMore detail')).toBe('/approved');
    expect(conversationCommand('/retry\tplease')).toBe('/retry');
    expect(conversationCommand('a reply with /approved')).toBeNull();
  });
});

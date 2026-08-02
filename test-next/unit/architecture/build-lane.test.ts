import { describe, expect, it } from 'vitest';

describe('target build lane', () => {
  it('runs independently from legacy tests', () => {
    expect('src-next').not.toBe('src');
  });
});

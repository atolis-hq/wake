import { describe, expect, it } from 'vitest';
import { resourceId } from '../../src-next/resources/index.js';

describe('Resource identifiers', () => {
  it('accepts the canonical resource identifier shape', () => {
    expect(resourceId('resource-1')).toBe('resource-1');
  });

  it('rejects invalid resource identifiers', () => {
    expect(() => resourceId('github:7')).toThrow('Invalid ResourceId');
  });
});

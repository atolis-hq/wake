import { describe, expect, it } from 'vitest';
import { resourceId } from '../../../src-next/resources/index.js';
import { resId } from '../../support/identities.js';

describe('Resource identifiers', () => {
  it('accepts the canonical resource identifier shape', () => {
    expect(resourceId(resId('one'))).toBe(resId('one'));
  });

  it('rejects invalid resource identifiers', () => {
    expect(() => resourceId('github:7')).toThrow('Invalid ResourceId');
  });
});

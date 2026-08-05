import { describe, expect, it } from 'vitest';
import { ResourceItemField } from '../../../src-next/surfaces/api/contracts/transport-values.js';

describe('ResourceItemField', () => {
  it('defines the adapter response field', () => {
    expect(ResourceItemField.Adapter).toBe('adapter');
  });
});

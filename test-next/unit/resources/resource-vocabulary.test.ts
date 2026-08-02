import { describe, expect, it } from 'vitest';

import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCapabilityRegistry,
  ResourceKindRegistry,
  resourceCapability,
  resourceKind,
} from '../../../src-next/resources/index.js';

describe('Resource vocabulary', () => {
  it('registers extensible Resource kinds and capabilities while exposing built-ins', () => {
    const kinds = new ResourceKindRegistry(Object.values(BuiltInResourceKind));
    const capabilities = new ResourceCapabilityRegistry(Object.values(BuiltInResourceCapability));
    const deployment = resourceKind('deployment');
    const promotable = resourceCapability('promotable');

    kinds.register(deployment);
    capabilities.register(promotable);

    expect(kinds.resolve('deployment')).toBe(deployment);
    expect(capabilities.resolve('promotable')).toBe(promotable);
    expect(kinds.resolve('repository')).toBe(BuiltInResourceKind.Repository);
    expect(capabilities.resolve('mergeable')).toBe(BuiltInResourceCapability.Mergeable);
  });

  it('rejects unregistered and malformed Resource vocabulary', () => {
    const kinds = new ResourceKindRegistry();
    expect(() => kinds.resolve('repository')).toThrow(/unknown Resource kind/i);
    expect(() => resourceKind('Pull Request')).toThrow(/invalid Resource kind/i);
    expect(() => resourceCapability('can merge')).toThrow(/invalid Resource capability/i);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActivityRegistry, activityName } from '../../../src-next/activities/index.js';
import { resourceCapability } from '../../../src-next/resources/index.js';

const definition = (name = 'implement') => ({
  name: activityName(name),
  inputSchema: z.object({ prompt: z.string().min(1) }),
  outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }),
  outcomeKinds: ['done', 'failed'],
  resources: [
    {
      capability: resourceCapability('revisioned'),
      cardinality: 'exactly-one' as const,
      role: 'primary' as const,
    },
  ],
  executionKind: 'agent' as const,
  handler: { execute: async () => ({ kind: 'done' }) },
});

describe('ActivityRegistry', () => {
  it('registers a named Activity with typed input and outcome schemas', () => {
    const registry = new ActivityRegistry();
    registry.register(definition());
    expect(registry.validateInput('implement', { prompt: 'Build it' })).toEqual({
      prompt: 'Build it',
    });
    expect(registry.validateOutcome('implement', { kind: 'done' })).toEqual({ kind: 'done' });
  });
  it('rejects duplicate Activity names', () => {
    const registry = new ActivityRegistry();
    registry.register(definition());
    expect(() => registry.register(definition())).toThrow('already registered');
  });
  it('rejects invalid activity.with input before a Run exists', () => {
    const registry = new ActivityRegistry();
    registry.register(definition());
    expect(() => registry.validateInput('implement', { prompt: '' })).toThrow('implement');
  });
  it('declares resource capability and cardinality requirements', () => {
    const registry = new ActivityRegistry();
    registry.register(definition());
    expect(registry.describe('implement').resources).toEqual([
      { capability: resourceCapability('revisioned'), cardinality: 'exactly-one', role: 'primary' },
    ]);
  });
});

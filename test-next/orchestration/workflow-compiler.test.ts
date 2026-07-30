import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../../src-next/activities/index.js';
import { compileWorkflow } from '../../src-next/orchestration/index.js';

function registry(): ActivityRegistry {
  const result = new ActivityRegistry();
  for (const name of ['implement', 'review']) {
    result.register({
      name,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.string() }).strict(),
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' };
        },
      },
    });
  }
  return result;
}

describe('compileWorkflow', () => {
  it('compiles owned shapes and defaults entry to the first stage', () => {
    const compiled = compileWorkflow(
      'default',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: { prompt: 'go' },
            execution: { workspace: 'branch', tier: 'standard' },
            on: {
              done: { activities: [{ use: 'review', with: { prompt: 'check' } }], then: 'done' },
            },
          },
        },
      },
      registry(),
    );
    expect(compiled.entry).toBe('implement');
    expect(compiled.stages.implement?.on.done?.id).toBe('default:implement:done');
    expect(compiled.stages.implement?.with).toEqual({ prompt: 'go' });
  });

  it.each([
    [
      'unknown Activity',
      { stages: { a: { activity: 'missing', with: {}, on: { done: { then: 'done' } } } } },
    ],
    [
      'invalid Activity input',
      { stages: { a: { activity: 'implement', with: {}, on: { done: { then: 'done' } } } } },
    ],
    [
      'unknown transition target',
      {
        stages: {
          a: { activity: 'implement', with: { prompt: 'x' }, on: { done: { then: 'missing' } } },
        },
      },
    ],
    [
      'unreachable stage',
      {
        stages: {
          a: { activity: 'implement', with: { prompt: 'x' }, on: { done: { then: 'done' } } },
          b: { activity: 'review', with: { prompt: 'x' }, on: { done: { then: 'done' } } },
        },
      },
    ],
  ])('rejects an %s', (_label, config) => {
    expect(() => compileWorkflow('default', config, registry())).toThrow();
  });

  it('requires a repeat limit on every cycle-closing route', () => {
    const config = {
      entry: 'a',
      stages: {
        a: { activity: 'implement', with: { prompt: 'x' }, on: { done: { then: 'b' } } },
        b: { activity: 'review', with: { prompt: 'x' }, on: { done: { then: 'a' } } },
      },
    };
    expect(() => compileWorkflow('loop', config, registry())).toThrow(/repeat\.max/);
    const bounded = structuredClone(config);
    bounded.stages.a.on.done = { then: 'b', repeat: { max: 2 } } as never;
    bounded.stages.b.on.done = { then: 'a', repeat: { max: 2 } } as never;
    expect(compileWorkflow('loop', bounded, registry()).entry).toBe('a');
  });

  it('does not require repository, issue, or provider configuration', () => {
    expect(
      compileWorkflow(
        'plain',
        {
          stages: {
            a: { activity: 'implement', with: { prompt: 'x' }, on: { done: { then: 'done' } } },
          },
        },
        registry(),
      ),
    ).toBeDefined();
  });
});

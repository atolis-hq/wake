import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActivityRegistry, activityName } from '../../../src/activities/index.js';
import { compileWorkflow, stageName } from '../../../src/orchestration/index.js';

function registry(): ActivityRegistry {
  const result = new ActivityRegistry();
  for (const name of ['implement', 'review']) {
    result.register({
      name: activityName(name),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.string() }).strict(),
      outcomeKinds: ['done'],
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
            execution: { workspace: 'branch', runnerPool: 'standard' },
            on: {
              done: { activities: [{ use: 'review', with: { prompt: 'check' } }], then: 'done' },
            },
          },
        },
      },
      registry(),
    );
    expect(compiled.entry).toBe('implement');
    expect(compiled.stages[stageName('implement')]?.on.done?.id).toBe('default:implement:done');
    expect(compiled.stages[stageName('implement')]?.with).toEqual({ prompt: 'go' });
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

  it('compiles a watch gate with a self-loop rejection target', () => {
    const compiled = compileWorkflow(
      'parent',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: { prompt: 'x' },
            on: { done: { then: 'done', watchGates: ['pr-review'] } },
          },
        },
        watches: [
          {
            id: 'pr-review',
            while: { stages: ['implement'], statuses: ['waiting'] },
            on: { events: ['review.requested'] },
            workflow: 'pr-review',
            maxPerGroup: 1,
          },
        ],
      },
      registry(),
      ['parent', 'pr-review'],
    );
    expect(compiled.stages[stageName('implement')]?.on.done?.watchGates?.[0]).toEqual({
      watch: 'pr-review',
      onRejectTarget: { kind: 'stage', stage: 'implement' },
    });
  });

  it('validates watchGate references and multiplicity', () => {
    const base = {
      stages: {
        implement: {
          activity: 'implement',
          with: { prompt: 'x' },
          on: { done: { then: 'done', watchGates: ['ghost'] } },
        },
      },
    };
    expect(() => compileWorkflow('parent', base, registry())).toThrow(/Unknown watch reference/);
    expect(() =>
      compileWorkflow(
        'parent',
        {
          ...base,
          stages: {
            implement: {
              ...base.stages.implement,
              on: { done: { then: 'done', watchGates: ['a', 'b'] } },
            },
          },
          watches: [
            {
              id: 'a',
              while: { stages: ['implement'], statuses: ['waiting'] },
              on: { events: ['a.event'] },
              workflow: 'a',
              maxPerGroup: 1,
            },
            {
              id: 'b',
              while: { stages: ['implement'], statuses: ['waiting'] },
              on: { events: ['b.event'] },
              workflow: 'b',
              maxPerGroup: 1,
            },
          ],
        },
        registry(),
        ['parent', 'a', 'b'],
      ),
    ).toThrow(/exactly 1 is supported/);
  });

  it('requires approval on a done route by default when nothing else gates it', () => {
    const compiled = compileWorkflow(
      'default',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: { prompt: 'x' },
            on: { done: { then: 'done' } },
          },
        },
      },
      registry(),
    );
    expect(compiled.stages[stageName('implement')]?.on.done?.await).toEqual({
      signal: 'approved',
      from: [{ kind: 'human' }],
      resume: { kind: 'complete' },
    });
  });

  it('skips the default approval when the stage opts out with requiresApproval: false', () => {
    const compiled = compileWorkflow(
      'default',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: { prompt: 'x' },
            on: { done: { then: 'done' } },
            requiresApproval: false,
          },
        },
      },
      registry(),
    );
    expect(compiled.stages[stageName('implement')]?.on.done?.await).toBeUndefined();
  });

  it('never layers the default approval on top of an explicit watchGate', () => {
    for (const requiresApproval of [undefined, true, false] as const) {
      const compiled = compileWorkflow(
        'parent',
        {
          stages: {
            implement: {
              activity: 'implement',
              with: { prompt: 'x' },
              on: { done: { then: 'done', watchGates: ['pr-review'] } },
              ...(requiresApproval === undefined ? {} : { requiresApproval }),
            },
          },
          watches: [
            {
              id: 'pr-review',
              while: { stages: ['implement'], statuses: ['waiting'] },
              on: { events: ['review.requested'] },
              workflow: 'pr-review',
              maxPerGroup: 1,
            },
          ],
        },
        registry(),
        ['parent', 'pr-review'],
      );
      const route = compiled.stages[stageName('implement')]?.on.done;
      expect(route?.await).toBeUndefined();
      expect(route?.watchGates).toHaveLength(1);
    }
  });
});

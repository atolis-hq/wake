import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  ActivityExecutionKind,
  ActivityRegistry,
  activityName,
} from '../../src-next/activities/index.js';
import {
  TransitionTargetKind,
  commandName,
  compileWorkflow,
  stageName,
  workflowName,
} from '../../src-next/orchestration/index.js';

function registry(): ActivityRegistry {
  const result = new ActivityRegistry();
  result.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'blocked']) }).strict(),
    outcomeKinds: ['done', 'blocked'],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  return result;
}

describe('compiled workflow contracts', () => {
  it('rejects a workflow outcome route not declared by its Activity', () => {
    expect(() =>
      compileWorkflow(
        'default',
        {
          stages: {
            implement: {
              activity: 'implement',
              with: {},
              on: { typo: { then: 'done' } },
            },
          },
        },
        registry(),
      ),
    ).toThrow(/outcome route.*typo.*implement/i);
  });

  it('compiles workflow, stage, Activity, and command names to branded identifiers', () => {
    const compiled = compileWorkflow(
      'default',
      {
        commands: {
          '/retry': {
            activity: 'implement',
            with: {},
            allowedActors: ['operator'],
          },
        },
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: { done: { then: 'done' }, blocked: { then: 'await-human' } },
          },
        },
      },
      registry(),
    );

    expect(compiled.name).toBe(workflowName('default'));
    expect(compiled.entry).toBe(stageName('implement'));
    expect(compiled.stages[stageName('implement')]?.activity).toBe(activityName('implement'));
    expect(compiled.commands[commandName('/retry')]?.activity).toBe(activityName('implement'));
  });

  it('compiles terminal words to structural targets rather than stage strings', () => {
    const compiled = compileWorkflow(
      'default',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: { done: { then: 'done' }, blocked: { then: 'await-human' } },
          },
        },
      },
      registry(),
    );

    const routes = compiled.stages[stageName('implement')]!.on;
    expect(routes.done?.target).toEqual({ kind: TransitionTargetKind.Complete });
    expect(routes.blocked?.target).toEqual({ kind: TransitionTargetKind.AwaitSignal });
    expect(routes.done).not.toHaveProperty('then');
  });

  it.each(['done', 'await-human'])('rejects the reserved stage name %s', (reserved) => {
    expect(() =>
      compileWorkflow(
        'default',
        {
          stages: {
            [reserved]: {
              activity: 'implement',
              with: {},
              on: { done: { then: 'done' }, blocked: { then: 'await-human' } },
            },
          },
        },
        registry(),
      ),
    ).toThrow(/reserved stage name/i);
  });
});

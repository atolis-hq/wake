import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../../src/bootstrap/config/root-schema.js';
import { runnerToolNotices } from '../../../src/bootstrap/runner-tool-notices.js';

function config(allowedTools: readonly string[] | undefined, runnerPool?: string) {
  return parseRootConfig({
    schemaVersion: 1,
    execution: {
      agentRunners: {
        codex: { kind: 'codex-cli', command: 'codex' },
        second: { kind: 'codex-cli', command: 'codex' },
        claude: { kind: 'claude-cli', command: 'claude' },
      },
      runnerPools: { mixed: ['codex', 'claude', 'second'], claude: ['claude'] },
      defaultRunnerPool: 'mixed',
    },
    orchestration: {
      workflows: {
        default: {
          stages: {
            inspect: {
              activity: 'agent',
              with: { prompt: 'Inspect', ...(allowedTools === undefined ? {} : { allowedTools }) },
              execution: { workspace: 'none', ...(runnerPool ? { runnerPool } : {}) },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
  });
}

describe('runner tool notices', () => {
  it.each([undefined, 'mixed'])(
    'warns for every Codex candidate in the resolved pool %s',
    (pool) => {
      const value = config(['Read'], pool);
      const before = structuredClone(value);
      expect(runnerToolNotices(value)).toEqual([
        'Workflow "default" stage "inspect": allowedTools is advisory and is not enforced by Codex runner "codex" (pool "mixed").',
        'Workflow "default" stage "inspect": allowedTools is advisory and is not enforced by Codex runner "second" (pool "mixed").',
      ]);
      expect(value).toEqual(before);
    },
  );

  it.each([undefined, []])('does not warn for absent or empty lists %s', (list) => {
    expect(runnerToolNotices(config(list))).toEqual([]);
  });

  it('does not warn for a pool without Codex', () => {
    expect(runnerToolNotices(config(['Read'], 'claude'))).toEqual([]);
  });

  it('does not interpret other activity inputs as agent requests', () => {
    const value = config(['Read']);
    value.orchestration.workflows.default!.stages.inspect!.activity = 'other';
    expect(runnerToolNotices(value)).toEqual([]);
  });
});

describe('template tool lists', () => {
  const templates = new Map([
    ['inspect', { name: 'inspect', body: 'Inspect', frontmatter: { allowedTools: ['Read'] } }],
  ]);

  function templateConfig(allowedTools?: readonly string[]) {
    const value = config(allowedTools);
    value.orchestration.workflows.default!.stages.inspect!.with = {
      template: 'inspect',
      ...(allowedTools === undefined ? {} : { allowedTools }),
    };
    return value;
  }

  it('warns for tools inherited from template frontmatter', () => {
    expect(runnerToolNotices(templateConfig(), templates)).toEqual(
      runnerToolNotices(config(['Read'])),
    );
  });

  it('honors an explicitly empty stage override', () => {
    expect(runnerToolNotices(templateConfig([]), templates)).toEqual([]);
  });

  it('honors a non-empty stage override of an empty template list', () => {
    const empty = new Map([
      ['inspect', { name: 'inspect', body: 'Inspect', frontmatter: { allowedTools: [] } }],
    ]);
    expect(runnerToolNotices(templateConfig(['Read']), empty)).toHaveLength(2);
  });

  it.each([undefined, null, []])(
    'does not warn for an unrestricted template (%s)',
    (allowedTools) => {
      const unrestricted = new Map([
        ['inspect', { name: 'inspect', body: 'Inspect', frontmatter: { allowedTools } }],
      ]);
      expect(runnerToolNotices(templateConfig(), unrestricted)).toEqual([]);
    },
  );

  it.each([undefined, ['Read']])(
    'does not warn when the referenced template failed to load (%s)',
    (tools) => {
      expect(runnerToolNotices(templateConfig(tools))).toEqual([]);
    },
  );
});

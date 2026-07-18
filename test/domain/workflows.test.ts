import { describe, expect, it } from 'vitest';

import { parseIssueStateRecord, parseWakeConfig } from '../../src/domain/schema.js';
import { chooseAction, nextStage, stageLabelsForWorkflow } from '../../src/domain/workflows.js';

function projectionAt(stage: string) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    workItemKey: 'work-01JZ0000000000000000000099',
    issue: {
      repo: 'atolis-hq/wake',
      number: 99,
      title: 'Example',
      body: 'Body',
      labels: [],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/99',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    wake: {
      stage,
      stageHistory: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
    },
  });
}

describe('workflow interpreter', () => {
  it('enters the first configured stage after queue without depending on workflow or stage names', () => {
    const config = parseWakeConfig({
      paths: { wakeRoot: '.wake' },
      workflows: {
        custom: {
          stages: {
            triage: {
              action: 'refine',
              workspace: 'read-only',
              tier: 'light',
              onDone: 'build',
            },
            build: {
              action: 'implement',
              workspace: 'branch',
              tier: 'standard',
              onDone: 'done',
            },
          },
        },
      },
    });
    const workflow = config.workflows.custom!;

    expect(chooseAction(projectionAt('queue'), workflow)).toMatchObject({
      stage: 'triage',
      action: 'refine',
      workspace: 'read-only',
    });
    expect(nextStage('triage', 'DONE', workflow)).toBe('build');
    expect(nextStage('build', 'DONE', workflow)).toBe('done');
    expect(nextStage('build', 'BLOCKED', workflow)).toBeNull();
    expect(stageLabelsForWorkflow(workflow)).toEqual([
      'wake:stage.queue',
      'wake:stage.triage',
      'wake:stage.build',
      'wake:stage.done',
    ]);
  });
});

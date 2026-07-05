import { describe, expect, it } from 'vitest';

import {
  isWakeAuthoredComment,
  parseEventRecord,
  parseIssueStateRecord,
  parseRunRecord,
  parseRunnerResultSentinel,
} from '../../src/domain/schema.js';

describe('issue state schema', () => {
  it('accepts canonical issue and comment fields plus extensible context', () => {
    const record = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: 'c1',
          body: 'Need more detail <!-- wake -->',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
          isWakeAuthored: true,
        },
      ],
      wake: {
        stage: 'queue',
        attempts: 0,
        stageHistory: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {
        agentBrief: 'Extra information for future prompts',
      },
    });

    expect(record.context.agentBrief).toBe('Extra information for future prompts');
  });

  it('rejects missing canonical wake stage', () => {
    expect(() =>
      parseIssueStateRecord({
        schemaVersion: 1,
        issue: {},
        comments: [],
        wake: {},
      }),
    ).toThrow(/stage/i);
  });
});

describe('run and event schemas', () => {
  it('accepts running run records', () => {
    const run = parseRunRecord({
      schemaVersion: 1,
      runId: 'run-1',
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      action: 'refine',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });

    expect(run.status).toBe('running');
  });

  it('accepts append-only event records', () => {
    const event = parseEventRecord({
      schemaVersion: 1,
      type: 'issue.synced',
      occurredAt: '2026-07-05T12:00:00.000Z',
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      payload: { labels: ['wake:queue'] },
    });

    expect(event.type).toBe('issue.synced');
  });

  it('parses the last sentinel occurrence from runner result text', () => {
    expect(parseRunnerResultSentinel('notes DONE more notes FAILED')).toBe('FAILED');
  });

  it('detects the wake comment marker in shared-account comments', () => {
    expect(isWakeAuthoredComment('Question <!-- wake -->')).toBe(true);
    expect(isWakeAuthoredComment('Human answer')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { labelsForWorkItem } from '../../src/adapters/github/status-labels.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { parseIssueStateRecord } from '../../src/domain/schema.js';
import type { WorkItemStatus } from '../../src/domain/work-item-status.js';

const root = '/tmp/status-labels-test';

function buildProjection(overrides: { stage?: string; context?: Record<string, unknown> }) {
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
    comments: [],
    wake: {
      stage: overrides.stage ?? 'implement',
      stageHistory: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
    },
    context: overrides.context ?? {},
    correlatedResources: [],
  });
}

describe('labelsForWorkItem', () => {
  const config = createDefaultWakeConfig(root);

  const statusCases: Array<{ status: WorkItemStatus; expected: string }> = [
    { status: 'queued', expected: 'wake:status.pending' },
    { status: 'working', expected: 'wake:status.working' },
    { status: 'awaiting-approval', expected: 'wake:status.awaiting-approval' },
    { status: 'changes-requested', expected: 'wake:status.changes-requested' },
    { status: 'blocked', expected: 'wake:status.blocked' },
    { status: 'done', expected: 'wake:status.completed' },
    { status: 'failed', expected: 'wake:status.failed' },
  ];

  it.each(statusCases)('translates status $status to $expected', ({ status, expected }) => {
    const projection = buildProjection({ context: { status } });
    expect(labelsForWorkItem(projection, config).statusLabel).toBe(expected);
  });

  it('translates the done stage with no folded status to wake:status.completed', () => {
    const projection = buildProjection({ stage: 'done', context: {} });
    expect(labelsForWorkItem(projection, config).statusLabel).toBe('wake:status.completed');
  });

  it('translates a non-done stage with no folded status to wake:status.pending (back-compat default)', () => {
    const projection = buildProjection({ stage: 'implement', context: {} });
    expect(labelsForWorkItem(projection, config).statusLabel).toBe('wake:status.pending');
  });

  it('falls back to lastRunSentinel for a legacy projection missing context.status', () => {
    const projection = buildProjection({
      context: { lastRunSentinel: 'AWAITING_APPROVAL' },
    });
    expect(labelsForWorkItem(projection, config).statusLabel).toBe('wake:status.awaiting-approval');
  });

  it('always includes the stage and workflow labels', () => {
    const projection = buildProjection({ stage: 'refine', context: { status: 'queued' } });
    const labels = labelsForWorkItem(projection, config);
    expect(labels.stageLabel).toBe('wake:stage.refine');
    expect(labels.workflowLabel).toBe('wake:workflow.default');
  });

  it('omits frozenLabel/scheduledLabel when neither flag is set', () => {
    const projection = buildProjection({ context: { status: 'queued' } });
    const labels = labelsForWorkItem(projection, config);
    expect(labels.frozenLabel).toBeUndefined();
    expect(labels.scheduledLabel).toBeUndefined();
  });

  it('includes frozenLabel when context.frozen is set, independent of status', () => {
    const projection = buildProjection({
      context: {
        status: 'awaiting-approval',
        frozen: { at: '2026-07-05T12:00:00.000Z', by: 'operator' },
      },
    });
    const labels = labelsForWorkItem(projection, config);
    expect(labels.statusLabel).toBe('wake:status.awaiting-approval');
    expect(labels.frozenLabel).toBe('wake:frozen');
  });

  it('includes scheduledLabel when context.scheduled is true', () => {
    const projection = buildProjection({ context: { status: 'queued', scheduled: true } });
    expect(labelsForWorkItem(projection, config).scheduledLabel).toBe('wake:scheduled-workflow');
  });

  it('combines a status label with both frozen and scheduled flags at once (orthogonal facts, §2)', () => {
    const projection = buildProjection({
      context: {
        status: 'blocked',
        scheduled: true,
        frozen: { at: '2026-07-05T12:00:00.000Z', by: 'operator' },
      },
    });
    const labels = labelsForWorkItem(projection, config);
    expect(labels.statusLabel).toBe('wake:status.blocked');
    expect(labels.frozenLabel).toBe('wake:frozen');
    expect(labels.scheduledLabel).toBe('wake:scheduled-workflow');
  });
});

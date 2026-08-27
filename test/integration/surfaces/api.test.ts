import { describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { RunStatus, runId, type RunView } from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { resourceKind, type ResourceView } from '../../../src/resources/index.js';
import {
  collectionResponse,
  decodeCursor,
  encodeCursor,
  fromWorkItemKey,
  resourceResponse,
  toWorkItemKey,
  workItemPath,
  type WorkDetailResponse,
} from '../../../src/surfaces/api/contracts/index.js';
import { presentRun } from '../../../src/surfaces/api/presenters/execution.js';
import { presentResource } from '../../../src/surfaces/api/presenters/resources.js';
import { redactConfiguration } from '../../../src/surfaces/api/presenters/system.js';
import {} from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';

describe('surface API contracts', () => {
  it('keeps cross-domain WorkItem results nested and addresses them by WorkItemKey', () => {
    const detail: WorkDetailResponse = {
      work: {
        workItemKey: toWorkItemKey('work-demo'),
        workItemId: 'work-demo',
        objective: 'Demo',
        state: 'open',
        relatedWorkItems: [],
      },
      resources: [],
      orchestration: {
        primary: null,
        children: [],
        diagram: { href: '/api/v1/workflow-diagrams?workItemKey=wk_demo' },
      },
      execution: { runs: [], transcriptGroups: [] },
      activities: {},
      conversation: { entries: [] },
    };

    expect(workItemPath('work-demo')).toBe('/api/v1/work-items/work-demo');
    expect(resourceResponse(detail, '2026-07-31T10:00:00.000Z').meta.asOf).toMatch(/Z$/);
    expect(collectionResponse([], '2026-07-31T10:00:00.000Z').page.hasMore).toBe(false);
  });

  it('maps the opaque route key explicitly to Wake-owned WorkItem identity', () => {
    const key = toWorkItemKey(workId('demo'));

    expect(key).toMatch(/^wk_/);
    expect(fromWorkItemKey(key)).toBe(workId('demo'));
    expect(workItemPath(key)).toBe(`/api/v1/work-items/${encodeURIComponent(key)}`);
    expect(() => fromWorkItemKey('github:issue:42')).toThrow(/WorkItemKey/);
  });

  it('uses validated opaque cursors', () => {
    const cursor = encodeCursor({ position: 42 });

    expect(cursor).not.toContain('42');
    expect(decodeCursor(cursor)).toEqual({ position: 42 });
    expect(() => decodeCursor('42')).toThrow(/cursor/i);
  });

  it('rejects response metadata timestamps that are not canonical UTC instants', () => {
    expect(() => resourceResponse({}, '2026-07-31T11:00:00+01:00')).toThrow(/UTC/);
    expect(() => collectionResponse([], '31 July 2026')).toThrow(/UTC/);
    expect(resourceResponse({}, '2026-07-31T10:00:00.000Z').meta.asOf).toBe(
      '2026-07-31T10:00:00.000Z',
    );
  });

  it('resolves a display-oriented resource locator but still redacts workspace paths', () => {
    const resource = presentResource(() => null)({
      resourceId: resId('1'),
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'github', key: 'owner/repo#42' },
      capabilities: [],
      revision: 'abc',
    } satisfies ResourceView);
    const run = presentRun({
      runId: runId('run-1'),
      activationId: activationId('activation-1'),
      activity: activityName('agent'),
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      status: RunStatus.Started,
      stage: 'refine',
      startedAt: '2026-07-31T10:00:00.000Z',
      workspace: { mode: 'branch', path: 'C:\\private\\worktree' },
      externalExecution: {
        kind: 'runner',
        id: 'provider-session',
        startedAt: '2026-07-31T10:00:00.000Z',
      },
    } as unknown as RunView);

    expect(resource).toMatchObject({
      adapter: 'github',
      locatorLabel: 'pull-request owner/repo#42',
    });
    expect(resource.externalUrl).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('private');
    expect(JSON.stringify(run)).not.toContain('provider-session');
    expect(run.stage).toBe('refine');
  });

  it('preserves an agent clarification sentinel while retaining the blocked activity outcome', () => {
    const run = presentRun({
      runId: runId('run-clarification'),
      activationId: activationId('activation-clarification'),
      activity: activityName('agent'),
      workflowInstanceId: workflowInstanceId('workflow-clarification'),
      orchestrationGroupId: orchestrationGroupId('group-clarification'),
      attempt: 1,
      status: RunStatus.Succeeded,
      startedAt: '2026-07-31T10:00:00.000Z',
      agent: {
        outcome: 'NEEDS_CLARIFICATION',
        displayBody: 'Which sentinel should I use?',
        metadata: {},
      },
      outcome: { kind: 'blocked', data: { status: 'NEEDS_CLARIFICATION' } },
    } as unknown as RunView);

    expect(run).toMatchObject({ sentinel: 'NEEDS_CLARIFICATION', outcome: { kind: 'blocked' } });
  });

  it('redacts configuration secrets recursively, including array entries', () => {
    const redacted = redactConfiguration({
      host: '127.0.0.1',
      runners: [{ credential: 'private-value', settings: { apiToken: 'token-value' } }],
    });
    expect(redacted).toEqual({
      host: '127.0.0.1',
      runners: [{ credential: '[redacted]', settings: { apiToken: '[redacted]' } }],
    });
    expect(JSON.stringify(redacted)).not.toContain('private-value');
    expect(JSON.stringify(redacted)).not.toContain('token-value');
  });
});

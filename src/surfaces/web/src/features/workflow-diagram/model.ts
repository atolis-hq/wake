import type {
  WorkflowDiagramActiveRunResponse,
  WorkflowDiagramChildKind,
  WorkflowDiagramChildResponse,
  WorkflowDiagramMetricsResponse,
  WorkflowDiagramResponse,
  WorkflowDiagramStageResponse,
  WorkflowDiagramStatus,
  WorkflowDiagramTransitionResponse,
} from '../../../../api/contracts/index.js';

export type { WorkflowDiagramChildKind, WorkflowDiagramStatus };
export type WorkflowDiagramMetrics = WorkflowDiagramMetricsResponse;
export type WorkflowDiagramActiveRun = WorkflowDiagramActiveRunResponse;
export type WorkflowDiagramChild = WorkflowDiagramChildResponse;
export type WorkflowDiagramStage = WorkflowDiagramStageResponse;
export type WorkflowDiagramTransition = WorkflowDiagramTransitionResponse;
export type WorkflowDiagram = WorkflowDiagramResponse;

export const mockWorkItemWorkflowDiagram: WorkflowDiagram = {
  id: 'work-item-dark-factory',
  label: 'Dark Factory - work-item run',
  direction: 'left-to-right',
  stages: [
    {
      id: 'refine',
      label: 'Refine',
      status: 'active',
      runCount: 4,
      totalDurationMs: 120_000,
      totalTokens: 23_600,
      inputTokens: 18_400,
      outputTokens: 5_200,
      cacheReadTokens: 4_100,
      cacheWriteTokens: 300,
      totalCostUsd: 0.41,
      children: [
        {
          id: 'refine-activity',
          label: 'Refine',
          kind: 'activity',
          status: 'active',
          activeRuns: [
            {
              runId: 'run-refine-004',
              activity: 'Refine',
              runnerName: 'codex',
              startedAt: '2026-08-22T17:58:00.000Z',
            },
          ],
          runCount: 2,
          totalDurationMs: 75_000,
          totalTokens: 15_700,
          inputTokens: 12_300,
          outputTokens: 3_400,
          cacheReadTokens: 2_500,
          cacheWriteTokens: 200,
          totalCostUsd: 0.28,
        },
        {
          id: 'refine-watch',
          label: 'Plan review',
          kind: 'watch-gate',
          status: 'waiting',
          runCount: 2,
          totalDurationMs: 45_000,
          totalTokens: 7_900,
          inputTokens: 6_100,
          outputTokens: 1_800,
          cacheReadTokens: 1_600,
          cacheWriteTokens: 100,
          totalCostUsd: 0.13,
        },
      ],
    },
    {
      id: 'implement',
      label: 'Implement',
      status: 'waiting',
      children: [
        {
          id: 'implement-activity',
          label: 'Implement',
          kind: 'activity',
          status: 'completed',
        },
        {
          id: 'implement-watch',
          label: 'PR review',
          kind: 'watch-gate',
          status: 'waiting',
        },
        {
          id: 'implement-approval-reactor',
          label: 'PR approved',
          kind: 'reactor',
          status: 'completed',
        },
        {
          id: 'implement-merged-reactor',
          label: 'PR merged',
          kind: 'reactor',
        },
      ],
    },
    {
      id: 'merge',
      label: 'Merge',
      status: 'blocked',
      children: [
        {
          id: 'merge-activity',
          label: 'PR merge',
          kind: 'activity',
          status: 'blocked',
        },
        {
          id: 'merge-merged-reactor',
          label: 'PR merged',
          kind: 'reactor',
          lastOutcome: 'failed',
        },
      ],
    },
    {
      id: 'complete-issue',
      label: 'Complete issue',
      children: [{ id: 'complete-issue-activity', label: 'Issue complete', kind: 'activity' }],
    },
  ],
  transitions: [
    { from: 'refine', to: 'implement', label: 'done' },
    {
      from: 'refine',
      fromChildId: 'refine-watch',
      to: 'implement',
      label: 'accepted',
    },
    { from: 'implement', to: 'merge', label: 'done' },
    {
      from: 'implement',
      fromChildId: 'implement-approval-reactor',
      to: 'merge',
      label: 'pr.review-accepted',
    },
    {
      from: 'implement',
      to: 'complete-issue',
      label: 'pr merged',
      fromChildId: 'implement-merged-reactor',
    },
    { from: 'merge', to: 'complete-issue', label: 'done' },
    {
      from: 'merge',
      to: 'complete-issue',
      label: 'pr merged',
      fromChildId: 'merge-merged-reactor',
    },
  ],
};

export const mockConfiguredWorkflowDiagrams: readonly WorkflowDiagram[] = [
  {
    id: 'dark-factory',
    label: 'Dark Factory - configuration',
    direction: 'left-to-right',
    stages: [
      {
        id: 'refine',
        label: 'Refine',
        children: [
          { id: 'refine-activity', label: 'Refine', kind: 'activity' },
          { id: 'refine-watch', label: 'Plan review', kind: 'watch-gate' },
        ],
      },
      {
        id: 'implement',
        label: 'Implement',
        children: [
          { id: 'implement-activity', label: 'Implement', kind: 'activity' },
          { id: 'implement-watch', label: 'PR review', kind: 'watch-gate' },
          {
            id: 'implement-approval-reactor',
            label: 'PR approved',
            kind: 'reactor',
          },
          {
            id: 'implement-merged-reactor',
            label: 'PR merged',
            kind: 'reactor',
          },
        ],
      },
      {
        id: 'merge',
        label: 'Merge',
        children: [
          { id: 'merge-activity', label: 'PR merge', kind: 'activity' },
          { id: 'merge-merged-reactor', label: 'PR merged', kind: 'reactor' },
        ],
      },
      {
        id: 'complete-issue',
        label: 'Complete issue',
        children: [{ id: 'complete-issue-activity', label: 'Issue complete', kind: 'activity' }],
      },
      {
        id: 'verify',
        label: 'Verify',
        children: [{ id: 'verify-activity', label: 'Verify delivery', kind: 'activity' }],
      },
      {
        id: 'publish',
        label: 'Publish',
        children: [{ id: 'publish-activity', label: 'Publish update', kind: 'activity' }],
      },
      {
        id: 'archive',
        label: 'Archive',
        children: [{ id: 'archive-activity', label: 'Archive record', kind: 'activity' }],
      },
    ],
    transitions: [
      { from: 'refine', to: 'implement', label: 'done' },
      {
        from: 'refine',
        fromChildId: 'refine-watch',
        to: 'implement',
        label: 'accepted',
      },
      { from: 'implement', to: 'merge', label: 'done' },
      {
        from: 'implement',
        fromChildId: 'implement-approval-reactor',
        to: 'merge',
        label: 'pr.review-accepted',
      },
      {
        from: 'implement',
        fromChildId: 'implement-merged-reactor',
        to: 'complete-issue',
        label: 'pr.state-changed: merged',
      },
      { from: 'merge', to: 'complete-issue', label: 'done' },
      {
        from: 'merge',
        fromChildId: 'merge-merged-reactor',
        to: 'complete-issue',
        label: 'pr.state-changed: merged',
      },
      { from: 'complete-issue', to: 'verify', label: 'done' },
      { from: 'verify', to: 'publish', label: 'verified' },
      { from: 'publish', to: 'archive', label: 'published' },
    ],
  },
];

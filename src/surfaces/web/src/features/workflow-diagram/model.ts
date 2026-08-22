export type WorkflowDiagramStatus = 'active' | 'waiting' | 'blocked' | 'completed';

export type WorkflowDiagramChildKind = 'activity' | 'watch' | 'watch-gate' | 'reactor';

export interface WorkflowDiagramMetrics {
  readonly runCount?: number;
  readonly totalDurationMs?: number;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalCostUsd?: number;
}

export interface WorkflowDiagramActiveRun {
  readonly runId: string;
  readonly activity: string;
  readonly runnerName?: string;
  readonly startedAt: string;
}

export interface WorkflowDiagramChild extends WorkflowDiagramMetrics {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkflowDiagramChildKind;
  readonly status?: WorkflowDiagramStatus;
  readonly lastOutcome?: string;
  readonly activeRuns?: readonly WorkflowDiagramActiveRun[];
}

export interface WorkflowDiagramStage extends WorkflowDiagramMetrics {
  readonly id: string;
  readonly label: string;
  readonly status?: WorkflowDiagramStatus;
  readonly lastOutcome?: string;
  readonly activeRuns?: readonly WorkflowDiagramActiveRun[];
  readonly children: readonly WorkflowDiagramChild[];
}

export interface WorkflowDiagramTransition {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface WorkflowDiagram {
  readonly id: string;
  readonly label: string;
  readonly direction: 'left-to-right';
  readonly stages: readonly WorkflowDiagramStage[];
  readonly transitions: readonly WorkflowDiagramTransition[];
}

export const mockWorkItemWorkflowDiagram: WorkflowDiagram = {
  id: 'work-item-481',
  label: 'Implement workflow diagram',
  direction: 'left-to-right',
  stages: [
    {
      id: 'refine',
      label: 'Refine',
      status: 'active',
      activeRuns: [
        {
          runId: 'run-refine-004',
          activity: 'Refine task',
          runnerName: 'codex',
          startedAt: '2026-08-22T17:58:00.000Z',
        },
      ],
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
          label: 'Refine task',
          kind: 'activity',
          status: 'active',
          runCount: 1,
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
          label: 'Wait for review',
          kind: 'watch',
          status: 'waiting',
          runCount: 2,
          totalDurationMs: 45_000,
        },
        {
          id: 'refine-reactor',
          label: 'React to updates',
          kind: 'reactor',
          status: 'active',
        },
      ],
    },
    {
      id: 'review',
      label: 'Review',
      children: [
        {
          id: 'review-activity',
          label: 'Review change',
          kind: 'activity',
        },
        {
          id: 'review-gate',
          label: 'Approval gate',
          kind: 'watch-gate',
        },
      ],
    },
    {
      id: 'deploy',
      label: 'Deploy',
      children: [
        {
          id: 'deploy-activity',
          label: 'Deploy release',
          kind: 'activity',
        },
        {
          id: 'deploy-reactor',
          label: 'Publish deployment',
          kind: 'reactor',
        },
      ],
    },
  ],
  transitions: [
    { from: 'refine', to: 'review', label: 'ready' },
    { from: 'review', to: 'deploy', label: 'approved' },
  ],
};

export const mockConfiguredWorkflowDiagrams: readonly WorkflowDiagram[] = [
  {
    id: 'standard-delivery',
    label: 'Standard delivery',
    direction: 'left-to-right',
    stages: [
      {
        id: 'refine',
        label: 'Refine',
        children: [{ id: 'refine-activity', label: 'Refine task', kind: 'activity' }],
      },
      {
        id: 'review',
        label: 'Review',
        children: [{ id: 'review-activity', label: 'Review change', kind: 'activity' }],
      },
      {
        id: 'deploy',
        label: 'Deploy',
        children: [{ id: 'deploy-activity', label: 'Deploy release', kind: 'activity' }],
      },
    ],
    transitions: [
      { from: 'refine', to: 'review', label: 'ready' },
      { from: 'review', to: 'deploy', label: 'approved' },
    ],
  },
  {
    id: 'guarded-delivery',
    label: 'Guarded delivery',
    direction: 'left-to-right',
    stages: [
      {
        id: 'refine',
        label: 'Refine',
        children: [
          { id: 'refine-activity', label: 'Refine task', kind: 'activity' },
          { id: 'refine-reactor', label: 'React to updates', kind: 'reactor' },
        ],
      },
      {
        id: 'review',
        label: 'Review',
        children: [{ id: 'review-gate', label: 'Approval gate', kind: 'watch-gate' }],
      },
      {
        id: 'deploy',
        label: 'Deploy',
        children: [
          { id: 'deploy-activity', label: 'Deploy release', kind: 'activity' },
          {
            id: 'deploy-reactor',
            label: 'Publish deployment',
            kind: 'reactor',
          },
        ],
      },
    ],
    transitions: [
      { from: 'refine', to: 'review', label: 'ready' },
      { from: 'review', to: 'deploy', label: 'approved' },
    ],
  },
];

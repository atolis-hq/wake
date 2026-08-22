export type WorkflowDiagramStatus = 'active' | 'waiting' | 'blocked' | 'completed';

export type WorkflowDiagramChildKind = 'activity' | 'watch' | 'watch-gate' | 'reactor';

export interface WorkflowDiagramMetrics {
  runCount?: number;
  totalDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface WorkflowDiagramChild extends WorkflowDiagramMetrics {
  id: string;
  label: string;
  kind: WorkflowDiagramChildKind;
  status?: WorkflowDiagramStatus;
  lastOutcome?: string;
  activeRuns?: number;
}

export interface WorkflowDiagramStage extends WorkflowDiagramMetrics {
  id: string;
  label: string;
  status?: WorkflowDiagramStatus;
  lastOutcome?: string;
  activeRuns?: number;
  children: readonly WorkflowDiagramChild[];
}

export interface WorkflowDiagramTransition {
  from: string;
  to: string;
  label: string;
}

export interface WorkflowDiagram {
  id: string;
  label: string;
  direction: 'left-to-right';
  stages: readonly WorkflowDiagramStage[];
  transitions: readonly WorkflowDiagramTransition[];
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
      activeRuns: 1,
      runCount: 4,
      totalDurationMs: 120_000,
      totalInputTokens: 18_400,
      totalOutputTokens: 5_200,
      totalCostUsd: 0.41,
      children: [
        {
          id: 'refine-activity',
          label: 'Refine task',
          kind: 'activity',
          status: 'active',
          activeRuns: 1,
          runCount: 1,
          totalDurationMs: 75_000,
          totalInputTokens: 12_300,
          totalOutputTokens: 3_400,
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

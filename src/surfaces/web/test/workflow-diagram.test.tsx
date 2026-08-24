import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDiagram } from '../src/features/workflow-diagram/model.js';
import { WorkflowDiagramView } from '../src/features/workflow-diagram/workflow-diagram.js';

const mockWorkItemWorkflowDiagram: WorkflowDiagram = {
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
        { id: 'implement-activity', label: 'Implement', kind: 'activity', status: 'completed' },
        { id: 'implement-watch', label: 'PR review', kind: 'watch-gate', status: 'waiting' },
        {
          id: 'implement-approval-reactor',
          label: 'PR approved',
          kind: 'reactor',
          status: 'completed',
        },
        { id: 'implement-merged-reactor', label: 'PR merged', kind: 'reactor' },
      ],
    },
    {
      id: 'merge',
      label: 'Merge',
      status: 'blocked',
      children: [
        { id: 'merge-activity', label: 'PR merge', kind: 'activity', status: 'blocked' },
        { id: 'merge-merged-reactor', label: 'PR merged', kind: 'reactor', lastOutcome: 'failed' },
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
    { from: 'refine', fromChildId: 'refine-watch', to: 'implement', label: 'accepted' },
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
      label: 'pr merged',
    },
    { from: 'merge', to: 'complete-issue', label: 'done' },
    {
      from: 'merge',
      fromChildId: 'merge-merged-reactor',
      to: 'complete-issue',
      label: 'pr merged',
    },
  ],
};

const mockConfiguredWorkflowDiagrams: readonly WorkflowDiagram[] = [
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
          { id: 'implement-approval-reactor', label: 'PR approved', kind: 'reactor' },
          { id: 'implement-merged-reactor', label: 'PR merged', kind: 'reactor' },
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
    ],
    transitions: [
      { from: 'refine', to: 'implement', label: 'done' },
      { from: 'refine', fromChildId: 'refine-watch', to: 'implement', label: 'accepted' },
      { from: 'implement', to: 'merge', label: 'done' },
      {
        from: 'implement',
        fromChildId: 'implement-approval-reactor',
        to: 'merge',
        label: 'pr.review-accepted',
      },
      { from: 'merge', to: 'complete-issue', label: 'done' },
    ],
  },
];

const instanceOverlayKeys = [
  'status',
  'lastOutcome',
  'activeRuns',
  'runCount',
  'totalDurationMs',
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalCostUsd',
] as const;

const aggregateFields = [
  'runCount',
  'totalDurationMs',
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalCostUsd',
] as const;

describe('mockWorkItemWorkflowDiagram', () => {
  it('provides the Dark Factory refine run and child breakdown', () => {
    const refine = mockWorkItemWorkflowDiagram.stages.find((stage) => stage.id === 'refine');

    expect(refine).toMatchObject({
      runCount: 4,
      totalDurationMs: 120_000,
    });
    expect(refine?.children.map((child) => child.kind)).toEqual(['activity', 'watch-gate']);
    expect(refine?.children.map((child) => child.runCount)).toEqual([2, 2]);
    expect(refine?.children[0]?.activeRuns).toEqual([
      {
        runId: 'run-refine-004',
        activity: 'Refine',
        runnerName: 'codex',
        startedAt: '2026-08-22T17:58:00.000Z',
      },
    ]);
    expect(refine).toMatchObject({
      totalTokens: 23_600,
      inputTokens: 18_400,
      outputTokens: 5_200,
      cacheReadTokens: 4_100,
      cacheWriteTokens: 300,
      totalCostUsd: 0.41,
    });

    const runnableChildren = refine?.children.filter((child) => child.kind !== 'reactor') ?? [];
    for (const field of aggregateFields) {
      const aggregate = runnableChildren.reduce((total, child) => total + (child[field] ?? 0), 0);
      if (field === 'totalCostUsd') {
        expect(refine?.[field]).toBeCloseTo(aggregate);
      } else {
        expect(refine?.[field]).toBe(aggregate);
      }
    }
  });

  it('leaves unreached stages without a status and reactors without agent metrics', () => {
    const reactors = mockWorkItemWorkflowDiagram.stages.flatMap((stage) =>
      stage.children.filter((child) => child.kind === 'reactor'),
    );

    expect(mockWorkItemWorkflowDiagram.stages.at(-1)?.status).toBeUndefined();
    expect(reactors).toHaveLength(3);
    for (const reactor of reactors) {
      for (const key of instanceOverlayKeys.slice(3)) {
        expect(reactor).not.toHaveProperty(key);
      }
    }
  });

  it('keeps configured workflow diagrams definition-only with labelled transitions', () => {
    for (const diagram of mockConfiguredWorkflowDiagrams) {
      expect(diagram.transitions).not.toHaveLength(0);
      expect(diagram.transitions.every((transition) => transition.label.length > 0)).toBe(true);
      for (const stage of diagram.stages) {
        for (const key of instanceOverlayKeys) {
          expect(stage).not.toHaveProperty(key);
        }
        for (const child of stage.children) {
          for (const key of instanceOverlayKeys) {
            expect(child).not.toHaveProperty(key);
          }
        }
      }
    }
  });

  it('models event routes as transitions from their nested watch or reactor cards', () => {
    const childRoutes = mockWorkItemWorkflowDiagram.transitions.filter(
      (transition) => transition.fromChildId !== undefined,
    );

    expect(childRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromChildId: 'refine-watch', to: 'implement' }),
        expect.objectContaining({ fromChildId: 'implement-approval-reactor', to: 'merge' }),
        expect.objectContaining({ fromChildId: 'implement-merged-reactor', to: 'complete-issue' }),
      ]),
    );
  });
});

describe('WorkflowDiagramView', () => {
  afterEach(cleanup);

  it('renders every child inside its desktop stage card without collapse controls', async () => {
    render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);

    const diagram = screen.getByRole('region', {
      name: `Workflow ${mockWorkItemWorkflowDiagram.label}`,
    });
    const refine = within(diagram).getByRole('group', { name: /Stage refine/i });
    expect(within(refine).getByText('4 runs')).toBeTruthy();
    expect(within(refine).getAllByText('Refine').length).toBeGreaterThan(1);
    expect(within(refine).getByText('Plan review')).toBeTruthy();
    expect(within(refine).getByText('codex')).toBeTruthy();
    expect(within(refine).getByText(/running/)).toBeTruthy();
    expect((await within(diagram).findAllByText('done')).length).toBeGreaterThan(0);
    expect(screen.getByText('PR merge')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Expand|Collapse) / })).toBeNull();
  });

  it('lets desktop stage cards grow around their children and uses a compact card title', () => {
    render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);

    const refine = screen.getByRole('group', { name: /Stage refine/i });
    const title = within(refine).getByText('Refine', { selector: 'strong' });

    expect(refine.style.height).toBe('');
    expect(refine.style.minHeight).toBe('');
    expect(within(refine).getAllByText('Refine').length).toBeGreaterThan(1);
    expect(within(refine).getByText('Plan review')).toBeTruthy();
    expect(title.className).toContain('cardTitle');
  });

  it('exposes board-style child status dots for every mocked child state', () => {
    render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);

    expect(screen.getByTestId('child-status-refine-activity').dataset.status).toBe('active');
    expect(screen.getByTestId('child-status-implement-activity').dataset.status).toBe('completed');
    expect(screen.getByTestId('child-status-implement-merged-reactor').dataset.status).toBe(
      'pending',
    );
    expect(screen.getByTestId('child-status-merge-activity').dataset.status).toBe('blocked');
    expect(screen.getByTestId('child-status-merge-merged-reactor').dataset.status).toBe('failed');
  });

  it('omits child status dots for definition-only diagrams', () => {
    render(<WorkflowDiagramView diagram={mockConfiguredWorkflowDiagrams[0]!} />);

    expect(screen.queryByTestId('child-status-refine-activity')).toBeNull();
  });

  it('uses semantic positioned labels and arrowheads for graph edges', async () => {
    render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);

    const diagram = screen.getByRole('region', {
      name: `Workflow ${mockWorkItemWorkflowDiagram.label}`,
    });
    const edgeLabel = (await within(diagram).findAllByText('done', { selector: 'span' }))[0]!;
    expect(edgeLabel.className).toContain('edgeLabel');
    expect(edgeLabel.getAttribute('style')).toMatch(/left: .*px/);
    expect(edgeLabel.getAttribute('style')).not.toContain('-9999px');
    expect(diagram.querySelector('marker#workflow-arrow')).toBeTruthy();
    expect(diagram.querySelector('path[marker-end="url(#workflow-arrow)"]')).toBeTruthy();
  });

  it('uses the mobile card surface to toggle stages and initially expands active stages', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        media: '(max-width: 42rem)',
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    const user = userEvent.setup();
    render(<WorkflowDiagramView diagram={mockWorkItemWorkflowDiagram} />);

    expect(screen.getByRole('button', { name: /^Refine/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: /^Merge/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByTestId('collapsed-status-merge-merge-activity').dataset.status).toBe(
      'blocked',
    );
    expect(screen.getByTestId('collapsed-status-merge-merge-merged-reactor').dataset.status).toBe(
      'failed',
    );
    expect(screen.queryByText('PR merge')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Merge/ }));
    expect(screen.getByRole('button', { name: /^Merge/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.queryByTestId('collapsed-status-merge-merge-activity')).toBeNull();
    expect(screen.getByText('PR merge')).toBeTruthy();

    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });
});

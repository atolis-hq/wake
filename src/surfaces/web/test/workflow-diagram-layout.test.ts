import { describe, expect, it } from 'vitest';

import { layoutWorkflowDiagram } from '../src/features/workflow-diagram/layout.js';

describe('layoutWorkflowDiagram', () => {
  it('returns positioned stages and routed transitions from the ELK layout engine', async () => {
    const layout = await layoutWorkflowDiagram(
      {
        id: 'release',
        label: 'Release',
        direction: 'left-to-right',
        stages: [
          { id: 'prepare', label: 'Prepare', children: [] },
          { id: 'publish', label: 'Publish', children: [] },
        ],
        transitions: [{ from: 'prepare', to: 'publish', label: 'ready' }],
      },
      'RIGHT',
    );

    expect(layout.nodes.map((node) => node.id)).toEqual(['prepare', 'publish']);
    expect(layout.nodes[1]!.x).toBeGreaterThan(layout.nodes[0]!.x);
    expect(layout.edges).toEqual([
      expect.objectContaining({ from: 'prepare', label: 'ready', to: 'publish' }),
    ]);
    expect(layout.edges[0]!.points.length).toBeGreaterThan(1);
  });

  it('stacks parallel stages vertically without overlap on desktop', async () => {
    const layout = await layoutWorkflowDiagram(
      {
        id: 'factory',
        label: 'Factory',
        direction: 'left-to-right',
        stages: [
          { id: 'review', label: 'Review', children: [] },
          { id: 'implement', label: 'Implement', children: [] },
          { id: 'revise', label: 'Revise', children: [] },
        ],
        transitions: [
          { from: 'review', to: 'implement', label: 'approved' },
          { from: 'review', to: 'revise', label: 'changes' },
        ],
      },
      'RIGHT',
    );

    const implement = layout.nodes.find((node) => node.id === 'implement')!;
    const revise = layout.nodes.find((node) => node.id === 'revise')!;
    expect(revise.x).toBe(implement.x);
    const [upper, lower] = implement.y < revise.y ? [implement, revise] : [revise, implement];
    expect(lower.y).toBeGreaterThanOrEqual(upper.y + upper.height);
  });

  it('keeps parallel stages apart at measured heights and still routes every transition', async () => {
    const layout = await layoutWorkflowDiagram(
      {
        id: 'factory',
        label: 'Factory',
        direction: 'left-to-right',
        stages: [
          { id: 'review', label: 'Review', children: [] },
          { id: 'implement', label: 'Implement', children: [] },
          { id: 'revise', label: 'Revise', children: [] },
          { id: 'ship', label: 'Ship', children: [] },
        ],
        transitions: [
          { from: 'review', to: 'implement', label: 'approved' },
          { from: 'review', to: 'revise', label: 'changes' },
          { from: 'implement', to: 'ship', label: 'finished' },
          { from: 'review', to: 'ship', label: 'skip' },
        ],
      },
      'RIGHT',
      new Map([
        ['implement', 400],
        ['revise', 300],
      ]),
    );

    const implement = layout.nodes.find((node) => node.id === 'implement')!;
    const revise = layout.nodes.find((node) => node.id === 'revise')!;
    expect(implement.height).toBe(400);
    expect(revise.height).toBe(300);
    const [upper, lower] = implement.y < revise.y ? [implement, revise] : [revise, implement];
    expect(lower.y).toBeGreaterThanOrEqual(upper.y + upper.height);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      'review>implement',
      'review>revise',
      'implement>ship',
      'review>ship',
    ]);
    for (const edge of layout.edges) expect(edge.points.length).toBeGreaterThan(1);
  });
});

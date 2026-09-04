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
});

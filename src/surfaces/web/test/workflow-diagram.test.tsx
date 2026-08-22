import { describe, expect, it } from 'vitest';
import { mockWorkItemWorkflowDiagram } from '../src/features/workflow-diagram/model.js';

describe('mockWorkItemWorkflowDiagram', () => {
  it('provides the requested refine run and child breakdown', () => {
    const refine = mockWorkItemWorkflowDiagram.stages.find((stage) => stage.id === 'refine');

    expect(refine).toMatchObject({
      runCount: 4,
      totalDurationMs: 120_000,
    });
    expect(refine?.children.map((child) => child.kind)).toEqual(['activity', 'watch', 'reactor']);
    expect(refine?.children.map((child) => child.runCount)).toEqual([1, 2, undefined]);
  });
});

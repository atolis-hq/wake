import { describe, expect, it } from 'vitest';
import {
  mockConfiguredWorkflowDiagrams,
  mockWorkItemWorkflowDiagram,
} from '../src/features/workflow-diagram/model.js';

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
  it('provides the requested refine run and child breakdown', () => {
    const refine = mockWorkItemWorkflowDiagram.stages.find((stage) => stage.id === 'refine');

    expect(refine).toMatchObject({
      runCount: 4,
      totalDurationMs: 120_000,
    });
    expect(refine?.children.map((child) => child.kind)).toEqual(['activity', 'watch', 'reactor']);
    expect(refine?.children.map((child) => child.runCount)).toEqual([2, 2, undefined]);
    expect(refine?.children[0]?.activeRuns).toEqual([
      {
        runId: 'run-refine-004',
        activity: 'Refine task',
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

    expect(
      mockWorkItemWorkflowDiagram.stages.slice(1).every((stage) => stage.status === undefined),
    ).toBe(true);
    expect(reactors).toHaveLength(2);
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
});

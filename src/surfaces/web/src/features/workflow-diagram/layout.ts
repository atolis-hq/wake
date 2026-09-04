import { createElkLayoutEngine } from './elk-runtime.js';
import type { WorkflowDiagram } from './model.js';

export const elk = createElkLayoutEngine();

export type WorkflowDiagramLayoutDirection = 'RIGHT' | 'DOWN';

export interface WorkflowDiagramNodeBounds {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkflowDiagramEdgePoint {
  readonly x: number;
  readonly y: number;
}

export interface WorkflowDiagramEdgeLayout {
  readonly id: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly fromChildId?: string;
  readonly points: readonly WorkflowDiagramEdgePoint[];
}

export interface WorkflowDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly WorkflowDiagramNodeBounds[];
  readonly edges: readonly WorkflowDiagramEdgeLayout[];
}

const stageWidth = 264;
// ELK only sees parent stages. These estimates mirror the compact board-card
// treatment closely enough for its edge endpoints to meet the rendered cards.
const stageHeaderHeight = 52;
const stageChildHeight = 54;
const stageChildGap = 5;

function stageHeight(childCount: number): number {
  if (childCount === 0) return stageHeaderHeight;
  return (
    stageHeaderHeight +
    stageChildGap +
    childCount * stageChildHeight +
    (childCount - 1) * stageChildGap
  );
}

export async function layoutWorkflowDiagram(
  diagram: WorkflowDiagram,
  direction: WorkflowDiagramLayoutDirection,
): Promise<WorkflowDiagramLayout> {
  const graph = await elk.layout({
    id: diagram.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '44',
      'elk.layered.spacing.nodeNodeBetweenLayers': '88',
    },
    children: diagram.stages.map((stage) => ({
      id: stage.id,
      width: stageWidth,
      height: stageHeight(stage.children.length),
    })),
    edges: diagram.transitions.map((transition, index) => ({
      id: `${transition.from}-${transition.to}-${index}`,
      sources: [transition.from],
      targets: [transition.to],
    })),
  });

  const nodes = (graph.children ?? []).map((node) => ({
    id: node.id,
    x: node.x ?? 0,
    // The desktop visual is a single left-to-right workflow lane. Child-card
    // routes may vary vertically, but stage cards always retain a shared top.
    y: direction === 'RIGHT' ? 0 : (node.y ?? 0),
    width: node.width ?? stageWidth,
    height: node.height ?? stageHeight(0),
  }));
  const edges = (graph.edges ?? []).map((edge, index) => {
    const transition = diagram.transitions[index];
    return {
      id: edge.id,
      label: transition?.label ?? '',
      from: transition?.from ?? '',
      to: transition?.to ?? '',
      ...(transition?.fromChildId === undefined ? {} : { fromChildId: transition.fromChildId }),
      points: (edge.sections ?? []).flatMap((section) => [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]),
    };
  });

  return Object.freeze({
    width: graph.width ?? stageWidth,
    height: graph.height ?? stageHeight(0),
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
    edges: Object.freeze(
      edges.map((edge) =>
        Object.freeze({
          ...edge,
          points: Object.freeze(edge.points.map((point) => Object.freeze(point))),
        }),
      ),
    ),
  });
}

import type { ElkNode } from 'elkjs/lib/elk-api.js';
import * as ELK from 'elkjs/lib/elk.bundled.js';

import type { WorkflowDiagram } from './model.js';

export const elk = new ELK.default.default();

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
  readonly points: readonly WorkflowDiagramEdgePoint[];
}

export interface WorkflowDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly WorkflowDiagramNodeBounds[];
  readonly edges: readonly WorkflowDiagramEdgeLayout[];
}

const stageWidth = 264;
const stageHeight = 116;

export async function layoutWorkflowDiagram(
  diagram: WorkflowDiagram,
  direction: WorkflowDiagramLayoutDirection,
): Promise<WorkflowDiagramLayout> {
  const graph = await elk.layout<ElkNode>({
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
      height: stageHeight,
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
    y: node.y ?? 0,
    width: node.width ?? stageWidth,
    height: node.height ?? stageHeight,
  }));
  const edges = (graph.edges ?? []).map((edge, index) => ({
    id: edge.id,
    label: diagram.transitions[index]?.label ?? '',
    points: (edge.sections ?? []).flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]),
  }));

  return Object.freeze({
    width: graph.width ?? stageWidth,
    height: graph.height ?? stageHeight,
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

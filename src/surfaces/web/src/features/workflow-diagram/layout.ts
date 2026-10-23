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

// The happy path is the longest loop-free chain from the first stage to a stage with no way
// onward. Everything off it (retries, revisions) is an excursion drawn beside the main row.
function happyPathStages(diagram: WorkflowDiagram): ReadonlySet<string> {
  const first = diagram.stages[0]?.id;
  if (first === undefined) return new Set();
  let best: readonly string[] = [];
  const visit = (path: readonly string[]) => {
    const onward = diagram.transitions.filter((transition) => transition.from === path.at(-1));
    if (onward.length === 0 && path.length > best.length) best = path;
    for (const { to } of onward) if (!path.includes(to)) visit([...path, to]);
  };
  visit([first]);
  return new Set(best);
}

const rowGap = 44;

// ELK keeps the main chain roughly level; pin it to one top row and drop excursions below any
// main-row card they would otherwise share a column with.
function alignHappyPath(
  nodes: readonly WorkflowDiagramNodeBounds[],
  mainStages: ReadonlySet<string>,
  transitions: WorkflowDiagram['transitions'],
): WorkflowDiagramNodeBounds[] {
  const main = nodes.filter((node) => mainStages.has(node.id));
  if (main.length < 2) return [...nodes];
  const top = Math.min(...nodes.map((node) => node.y));
  const placed = new Map<string, WorkflowDiagramNodeBounds>();
  for (const node of main) placed.set(node.id, { ...node, y: top });
  const others = nodes.filter((node) => !mainStages.has(node.id)).sort((a, b) => a.y - b.y);
  for (const laidOut of others) {
    // A loop excursion (entered from and returning to a main-row stage) hangs under that stage.
    const neighbour = transitions
      .filter((transition) => transition.from === laidOut.id)
      .map((transition) => transition.to)
      .find(
        (id) =>
          mainStages.has(id) &&
          transitions.some((back) => back.from === id && back.to === laidOut.id),
      );
    const anchor = neighbour === undefined ? undefined : placed.get(neighbour);
    const node = anchor === undefined ? laidOut : { ...laidOut, x: anchor.x, y: top };
    let y = node.y;
    for (const other of [...placed.values()].sort((a, b) => a.y - b.y)) {
      const sharesColumn = node.x < other.x + other.width && other.x < node.x + node.width;
      if (sharesColumn && y < other.y + other.height + rowGap && other.y < y + node.height) {
        y = other.y + other.height + rowGap;
      }
    }
    placed.set(node.id, { ...node, y });
  }
  return nodes.map((node) => placed.get(node.id)!);
}

export async function layoutWorkflowDiagram(
  diagram: WorkflowDiagram,
  direction: WorkflowDiagramLayoutDirection,
  // Rendered stage heights; cards grow past the estimate (totals, metrics, active runs).
  measuredHeights: ReadonlyMap<string, number> = new Map(),
): Promise<WorkflowDiagramLayout> {
  const graph = await elk.layout({
    id: diagram.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '44',
      // Headroom above the top row for routes that skip over cards.
      'elk.padding': '[top=40,left=12,bottom=12,right=12]',
      'elk.layered.spacing.nodeNodeBetweenLayers': '88',
      // Configuration order wins top to bottom within a column.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Reverse true back-edges (relative to the entry stage) so loops never reorder the main flow.
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    },
    children: diagram.stages.map((stage) => ({
      id: stage.id,
      width: stageWidth,
      height: measuredHeights.get(stage.id) ?? stageHeight(stage.children.length),
    })),
    edges: diagram.transitions.map((transition, index) => ({
      id: `${transition.from}-${transition.to}-${index}`,
      sources: [transition.from],
      targets: [transition.to],
    })),
  });

  const laidOut = (graph.children ?? []).map((node) => ({
    id: node.id,
    x: node.x ?? 0,
    // Parallel stages share a layer, so ELK's vertical placement keeps them apart.
    y: node.y ?? 0,
    width: node.width ?? stageWidth,
    height: node.height ?? stageHeight(0),
  }));
  const nodes = alignHappyPath(laidOut, happyPathStages(diagram), diagram.transitions);
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
    height: Math.max(
      graph.height ?? stageHeight(0),
      ...nodes.map((node) => node.y + node.height + 12),
    ),
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

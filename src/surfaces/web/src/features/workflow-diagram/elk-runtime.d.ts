export interface ElkLayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface ElkLayoutSection {
  readonly bendPoints?: readonly ElkLayoutPoint[];
  readonly endPoint: ElkLayoutPoint;
  readonly startPoint: ElkLayoutPoint;
}

export interface ElkLayoutEdge {
  readonly id: string;
  readonly sections?: readonly ElkLayoutSection[];
  readonly sources?: readonly string[];
  readonly targets?: readonly string[];
}

export interface ElkLayoutNode {
  readonly children?: readonly ElkLayoutNode[];
  readonly edges?: readonly ElkLayoutEdge[];
  readonly height?: number;
  readonly id: string;
  readonly layoutOptions?: Readonly<Record<string, string>>;
  readonly width?: number;
  readonly x?: number;
  readonly y?: number;
}

export interface ElkLayoutEngine {
  layout(graph: ElkLayoutNode): Promise<ElkLayoutNode>;
}

export function createElkLayoutEngine(): ElkLayoutEngine;

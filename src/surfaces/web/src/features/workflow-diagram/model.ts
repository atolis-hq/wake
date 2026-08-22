import type {
  WorkflowDiagramChildKind,
  WorkflowDiagramChildResponse,
  WorkflowDiagramMetricsResponse,
  WorkflowDiagramResponse,
  WorkflowDiagramStatus,
} from '../../../../api/contracts/index.js';

export type { WorkflowDiagramChildKind, WorkflowDiagramStatus };

export type WorkflowDiagramMetrics = WorkflowDiagramMetricsResponse;

export type WorkflowDiagramChild = WorkflowDiagramChildResponse;

export type WorkflowDiagram = WorkflowDiagramResponse;

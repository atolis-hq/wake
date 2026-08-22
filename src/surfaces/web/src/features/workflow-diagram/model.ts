import type {
  WorkflowDiagramActiveRunResponse,
  WorkflowDiagramChildKind,
  WorkflowDiagramChildResponse,
  WorkflowDiagramMetricsResponse,
  WorkflowDiagramResponse,
  WorkflowDiagramStageResponse,
  WorkflowDiagramStatus,
  WorkflowDiagramTransitionResponse,
} from '../../../../api/contracts/index.js';

export type { WorkflowDiagramChildKind, WorkflowDiagramStatus };

export type WorkflowDiagramMetrics = WorkflowDiagramMetricsResponse;

export type WorkflowDiagramActiveRun = WorkflowDiagramActiveRunResponse;

export type WorkflowDiagramChild = WorkflowDiagramChildResponse;

export type WorkflowDiagramStage = WorkflowDiagramStageResponse;

export type WorkflowDiagramTransition = WorkflowDiagramTransitionResponse;

export type WorkflowDiagram = WorkflowDiagramResponse;

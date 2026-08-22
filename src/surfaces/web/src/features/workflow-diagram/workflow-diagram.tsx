import { useEffect, useState, type CSSProperties } from 'react';
import { Chip } from '../../components/chip.js';
import { fmtCost, fmtDuration } from '../../components/format.js';
import { OutcomeChip } from '../../components/outcome-chip.js';
import { TokenUsage } from '../../components/token-usage.js';
import boardStyles from '../features.module.css';
import {
  layoutWorkflowDiagram,
  type WorkflowDiagramLayout,
  type WorkflowDiagramLayoutDirection,
} from './layout.js';
import type {
  WorkflowDiagram,
  WorkflowDiagramChild,
  WorkflowDiagramMetrics,
  WorkflowDiagramStatus,
} from './model.js';
import styles from './workflow-diagram.module.css';

const fallbackLayout: WorkflowDiagramLayout = { width: 0, height: 0, nodes: [], edges: [] };

function tone(
  status: WorkflowDiagramStatus | undefined,
): 'good' | 'warning' | 'bad' | 'info' | 'neutral' {
  if (status === 'active') return 'info';
  if (status === 'waiting') return 'warning';
  if (status === 'blocked') return 'bad';
  if (status === 'completed') return 'good';
  return 'neutral';
}

function useDiagramLayout(diagram: WorkflowDiagram, direction: WorkflowDiagramLayoutDirection) {
  const [layout, setLayout] = useState<WorkflowDiagramLayout>(fallbackLayout);
  useEffect(() => {
    let current = true;
    void layoutWorkflowDiagram(diagram, direction).then((next) => {
      if (current) setLayout(next);
    });
    return () => {
      current = false;
    };
  }, [diagram, direction]);
  return layout;
}

function useLayoutDirection(): WorkflowDiagramLayoutDirection {
  const [direction, setDirection] = useState<WorkflowDiagramLayoutDirection>(() =>
    globalThis.matchMedia?.('(max-width: 42rem)').matches ? 'DOWN' : 'RIGHT',
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.('(max-width: 42rem)');
    if (query === undefined) return;
    const update = () => setDirection(query.matches ? 'DOWN' : 'RIGHT');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return direction;
}

function tokenUsage(item: WorkflowDiagramMetrics) {
  if (item.totalTokens === undefined) return null;
  return (
    <TokenUsage
      usage={{
        totalTokens: item.totalTokens,
        ...(item.inputTokens === undefined ? {} : { inputTokens: item.inputTokens }),
        ...(item.outputTokens === undefined ? {} : { outputTokens: item.outputTokens }),
        ...(item.cacheReadTokens === undefined ? {} : { cacheReadTokens: item.cacheReadTokens }),
        ...(item.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: item.cacheWriteTokens }),
      }}
    />
  );
}

function metrics(item: WorkflowDiagramChild) {
  if (item.kind === 'reactor') return null;
  return (
    <div className={styles.metrics}>
      {item.runCount === undefined ? null : <span>{item.runCount} runs</span>}
      {item.totalDurationMs === undefined ? null : <span>{fmtDuration(item.totalDurationMs)}</span>}
      {item.totalCostUsd === undefined ? null : <span>{fmtCost(item.totalCostUsd)}</span>}
      {item.totalTokens === undefined ? <span>no token usage</span> : tokenUsage(item)}
    </div>
  );
}

function ChildCard({ child }: { readonly child: WorkflowDiagramChild }) {
  const status = child.lastOutcome === 'failed' ? 'failed' : (child.status ?? 'pending');
  return (
    <article className={`${styles.childCard} ${boardStyles.childRun}`} data-kind={child.kind}>
      <span
        aria-label={`${status} status`}
        className={`${boardStyles.childRunDot} ${styles.childStatusDot}`}
        data-status={status}
        data-testid={`child-status-${child.id}`}
        role="img"
      />
      <div>
        <div className={boardStyles.childRunTitle}>{child.label}</div>
        <div className={styles.chips}>
          {child.status === undefined ? null : (
            <Chip variant="outline" tone={tone(child.status)}>
              {child.status}
            </Chip>
          )}
          {child.lastOutcome === undefined ? null : <OutcomeChip outcome={child.lastOutcome} />}
        </div>
        {metrics(child)}
        {child.kind === 'reactor'
          ? null
          : child.activeRuns?.map((run) => (
              <div className={boardStyles.childRunMeta} key={run.runId}>
                <span>{run.activity} running</span>
                {run.runnerName === undefined ? null : (
                  <>
                    {' '}
                    · <span>{run.runnerName}</span>
                  </>
                )}
                {' · '}
                <span>
                  {fmtDuration(Math.max(0, Date.now() - new Date(run.startedAt).getTime()))}
                </span>
              </div>
            ))}
      </div>
    </article>
  );
}

function edgePath(points: readonly { readonly x: number; readonly y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function edgeLabelPoint(points: readonly { readonly x: number; readonly y: number }[]) {
  if (points.length === 0) return undefined;
  if (points.length === 1) return points[0];

  const lengths = points
    .slice(1)
    .map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const halfLength = lengths.reduce((total, length) => total + length, 0) / 2;
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (travelled + length >= halfLength) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const ratio = (halfLength - travelled) / length;
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
    travelled += length;
  }
  return points.at(-1);
}

export function WorkflowDiagramView({ diagram }: { readonly diagram: WorkflowDiagram }) {
  const direction = useLayoutDirection();
  const layout = useDiagramLayout(diagram, direction);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(diagram.stages.filter((stage) => stage.status === 'active').map((stage) => stage.id)),
  );
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const expandedAny = expanded.size > 0;
  const width = layout.width || (direction === 'RIGHT' ? diagram.stages.length * 352 : 300);
  const height = layout.height || (direction === 'RIGHT' ? 176 : diagram.stages.length * 172);

  return (
    <section className={styles.diagram} aria-label={`Workflow ${diagram.label}`}>
      <div
        className={styles.canvas}
        data-direction={direction}
        style={{ '--graph-width': `${width}px`, '--graph-height': `${height}px` } as CSSProperties}
      >
        <svg
          className={styles.edges}
          aria-hidden="true"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <defs>
            <marker
              id="workflow-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            return (
              <g key={edge.id}>
                <path d={edgePath(edge.points)} markerEnd="url(#workflow-arrow)" />
              </g>
            );
          })}
        </svg>
        {layout.edges.map((edge) => {
          const point = edgeLabelPoint(edge.points);
          return point === undefined || edge.label.length === 0 ? null : (
            <span
              className={styles.edgeLabel}
              key={`${edge.id}-label`}
              style={{ left: `${point.x}px`, top: `${point.y}px` }}
            >
              {edge.label}
            </span>
          );
        })}
        {diagram.stages.map((stage, index) => {
          const node = nodeById.get(stage.id);
          const isExpanded = direction === 'RIGHT' || expanded.has(stage.id);
          const fallbackX = direction === 'RIGHT' ? index * 352 : 18;
          const fallbackY = direction === 'RIGHT' ? 20 : index * 172;
          return (
            <div
              className={`${styles.stage} ${boardStyles.card}`}
              key={stage.id}
              role="group"
              aria-label={`Stage ${stage.id}`}
              style={
                {
                  left: `${node?.x ?? fallbackX}px`,
                  top: `${node?.y ?? fallbackY}px`,
                  width: `${node?.width ?? 264}px`,
                } as CSSProperties
              }
            >
              <div className={`${styles.stageCard} ${boardStyles.cardLink}`}>
                <div>
                  <strong className={boardStyles.cardTitle}>{stage.label}</strong>
                  <div className={styles.chips}>
                    {stage.status === undefined ? null : (
                      <Chip variant="outline" tone={tone(stage.status)}>
                        {stage.status}
                      </Chip>
                    )}
                    {stage.lastOutcome === undefined ? null : (
                      <OutcomeChip outcome={stage.lastOutcome} />
                    )}
                  </div>
                </div>
                {direction === 'DOWN' ? (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${stage.label}`}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(stage.id)) next.delete(stage.id);
                        else next.add(stage.id);
                        return next;
                      })
                    }
                  >
                    {isExpanded ? '−' : '+'}
                  </button>
                ) : null}
                <div className={styles.stageTotals}>
                  <span>{stage.runCount === undefined ? 'no runs' : `${stage.runCount} runs`}</span>
                  {stage.totalDurationMs === undefined ? null : (
                    <span>{fmtDuration(stage.totalDurationMs)}</span>
                  )}
                  {stage.totalCostUsd === undefined ? null : (
                    <span>{fmtCost(stage.totalCostUsd)}</span>
                  )}
                  {tokenUsage(stage)}
                </div>
              </div>
              {isExpanded ? (
                <div className={styles.children}>
                  {stage.children.map((child) => (
                    <ChildCard child={child} key={child.id} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {expandedAny ? null : <span className={styles.srOnly}>All stages are collapsed.</span>}
      </div>
    </section>
  );
}

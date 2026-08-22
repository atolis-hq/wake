import { faBolt } from '@fortawesome/free-solid-svg-icons/faBolt';
import { faEye } from '@fortawesome/free-solid-svg-icons/faEye';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { fmtCost, fmtDuration } from '../../components/format.js';
import { TokenUsage } from '../../components/token-usage.js';
import boardStyles from '../features.module.css';
import {
  layoutWorkflowDiagram,
  type WorkflowDiagramLayout,
  type WorkflowDiagramLayoutDirection,
} from './layout.js';
import type { WorkflowDiagram, WorkflowDiagramChild, WorkflowDiagramMetrics } from './model.js';
import styles from './workflow-diagram.module.css';

const fallbackLayout: WorkflowDiagramLayout = { width: 0, height: 0, nodes: [], edges: [] };

const childKindIcon = {
  activity: faRobot,
  watch: faEye,
  'watch-gate': faEye,
  reactor: faBolt,
} as const;

interface DiagramAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
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

function useDiagramAnchors(layout: WorkflowDiagramLayout) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  const [anchors, setAnchors] = useState<ReadonlyMap<string, DiagramAnchor>>(new Map());
  const stageRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element === null) elementsRef.current.delete(id);
    else elementsRef.current.set(id, element);
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || layout.nodes.length === 0) return;
    const measure = () => {
      const canvasBox = canvas.getBoundingClientRect();
      const next = new Map<string, DiagramAnchor>();
      for (const [id, element] of elementsRef.current) {
        const box = element.getBoundingClientRect();
        next.set(id, {
          left: box.left - canvasBox.left,
          top: box.top - canvasBox.top,
          right: box.right - canvasBox.left,
          bottom: box.bottom - canvasBox.top,
        });
        for (const child of element.querySelectorAll<HTMLElement>('[data-diagram-child]')) {
          const childBox = child.getBoundingClientRect();
          const childId = child.dataset.diagramChild;
          if (childId === undefined) continue;
          next.set(`${id}:${childId}`, {
            left: childBox.left - canvasBox.left,
            top: childBox.top - canvasBox.top,
            right: childBox.right - canvasBox.left,
            bottom: childBox.bottom - canvasBox.top,
          });
        }
      }
      setAnchors(next);
    };
    measure();
    const observer =
      globalThis.ResizeObserver === undefined ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    for (const element of elementsRef.current.values()) observer?.observe(element);
    return () => observer?.disconnect();
  }, [layout]);

  return { anchors, canvasRef, stageRef };
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
  if (
    item.kind === 'reactor' ||
    (item.runCount === undefined &&
      item.totalDurationMs === undefined &&
      item.totalCostUsd === undefined &&
      item.totalTokens === undefined)
  ) {
    return null;
  }
  return (
    <div className={styles.metrics}>
      {item.runCount === undefined ? null : <span>{item.runCount} runs</span>}
      {item.totalDurationMs === undefined ? null : <span>{fmtDuration(item.totalDurationMs)}</span>}
      {item.totalCostUsd === undefined ? null : <span>{fmtCost(item.totalCostUsd)}</span>}
      {item.totalTokens === undefined ? null : tokenUsage(item)}
    </div>
  );
}

function ChildCard({
  child,
  onHover,
}: {
  readonly child: WorkflowDiagramChild;
  readonly onHover: (childId: string | undefined) => void;
}) {
  const status = child.lastOutcome === 'failed' ? 'failed' : (child.status ?? 'pending');
  const hasActiveRun = (child.activeRuns?.length ?? 0) > 0;
  return (
    <article
      className={`${styles.childCard} ${boardStyles.childRun}`}
      data-diagram-child={child.id}
      data-kind={child.kind}
      onMouseEnter={() => onHover(child.id)}
      onMouseLeave={() => onHover(undefined)}
    >
      <span
        aria-label={hasActiveRun ? 'active run' : `${status} status`}
        className={`${boardStyles.childRunDot} ${styles.childStatusDot}`}
        data-status={status}
        data-active-run={hasActiveRun || undefined}
        data-testid={`child-status-${child.id}`}
        role="img"
      />
      <div>
        <div className={`${boardStyles.childRunTitle} ${styles.childTitle}`}>
          <FontAwesomeIcon className={styles.childKindIcon} icon={childKindIcon[child.kind]} />
          <span>{child.label}</span>
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
  if (points.length < 2) return '';
  const radius = 10;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1];
    if (next === undefined) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }
    const incoming = Math.min(
      radius,
      Math.hypot(current.x - previous.x, current.y - previous.y) / 2,
    );
    const outgoing = Math.min(radius, Math.hypot(next.x - current.x, next.y - current.y) / 2);
    const before = {
      x:
        current.x +
        ((previous.x - current.x) * incoming) /
          Math.hypot(previous.x - current.x, previous.y - current.y),
      y:
        current.y +
        ((previous.y - current.y) * incoming) /
          Math.hypot(previous.x - current.x, previous.y - current.y),
    };
    const after = {
      x:
        current.x +
        ((next.x - current.x) * outgoing) / Math.hypot(next.x - current.x, next.y - current.y),
      y:
        current.y +
        ((next.y - current.y) * outgoing) / Math.hypot(next.x - current.x, next.y - current.y),
    };
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  return path;
}

function sourceChildIdFor(edge: WorkflowDiagramLayout['edges'][number], diagram: WorkflowDiagram) {
  if (edge.fromChildId !== undefined) return edge.fromChildId;
  return diagram.stages
    .find((stage) => stage.id === edge.from)
    ?.children.find((child) => child.kind === 'activity')?.id;
}

function transitionPoints(
  edge: WorkflowDiagramLayout['edges'][number],
  diagram: WorkflowDiagram,
  nodes: ReadonlyMap<string, WorkflowDiagramLayout['nodes'][number]>,
  anchors: ReadonlyMap<string, DiagramAnchor>,
  direction: WorkflowDiagramLayoutDirection,
) {
  if (edge.points.length === 0) return edge.points;
  const source = nodes.get(edge.from);
  const stage = diagram.stages.find((candidate) => candidate.id === edge.from);
  const sourceChildId = sourceChildIdFor(edge, diagram);
  const childIndex = stage?.children.findIndex((child) => child.id === sourceChildId) ?? -1;
  const sourceAnchor = anchors.get(
    sourceChildId === undefined ? edge.from : `${edge.from}:${sourceChildId}`,
  );
  const targetAnchor = anchors.get(edge.to);
  if (sourceAnchor !== undefined && targetAnchor !== undefined) {
    const sourcePoint =
      direction === 'RIGHT'
        ? { x: sourceAnchor.right, y: (sourceAnchor.top + sourceAnchor.bottom) / 2 }
        : { x: (sourceAnchor.left + sourceAnchor.right) / 2, y: sourceAnchor.bottom };
    const targetPoint =
      direction === 'RIGHT'
        ? { x: targetAnchor.left, y: targetAnchor.top + 16 }
        : { x: (targetAnchor.left + targetAnchor.right) / 2, y: targetAnchor.top };
    if (direction === 'RIGHT') {
      const obstacles = diagram.stages
        .filter((stage) => stage.id !== edge.from && stage.id !== edge.to)
        .map((stage) => anchors.get(stage.id))
        .filter(
          (anchor): anchor is DiagramAnchor =>
            anchor !== undefined && anchor.left >= sourcePoint.x && anchor.right <= targetPoint.x,
        );
      if (obstacles.length > 0) {
        const laneY =
          Math.max(sourceAnchor.bottom, targetAnchor.bottom, ...obstacles.map((x) => x.bottom)) +
          24;
        const exitX = sourcePoint.x + 18;
        const entryX = targetPoint.x - 18;
        return [
          sourcePoint,
          { x: exitX, y: sourcePoint.y },
          { x: exitX, y: laneY },
          { x: entryX, y: laneY },
          { x: entryX, y: targetPoint.y },
          targetPoint,
        ];
      }
      if (sourcePoint.y === targetPoint.y) return [sourcePoint, targetPoint];
      const middleX = (sourcePoint.x + targetPoint.x) / 2;
      return [
        sourcePoint,
        { x: middleX, y: sourcePoint.y },
        { x: middleX, y: targetPoint.y },
        targetPoint,
      ];
    }
    if (sourcePoint.x === targetPoint.x) return [sourcePoint, targetPoint];
    const middleY = (sourcePoint.y + targetPoint.y) / 2;
    return [
      sourcePoint,
      { x: sourcePoint.x, y: middleY },
      { x: targetPoint.x, y: middleY },
      targetPoint,
    ];
  }
  if (sourceChildId === undefined || source === undefined || childIndex < 0) return edge.points;

  // ELK lays out stages only; this shifts the visible route origin to its nested child card.
  const childOffset = 52 + 5 + childIndex * 59 + 27;
  const childPoint =
    direction === 'RIGHT'
      ? { x: source.x + source.width, y: source.y + childOffset }
      : { x: source.x + source.width / 2, y: source.y + childOffset + 52 };
  return [childPoint, ...edge.points.slice(1)];
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
  const { anchors, canvasRef, stageRef } = useDiagramAnchors(layout);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(diagram.stages.filter((stage) => stage.status === 'active').map((stage) => stage.id)),
  );
  const [hoveredChildId, setHoveredChildId] = useState<string>();
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const expandedAny = expanded.size > 0;
  const width = layout.width || (direction === 'RIGHT' ? diagram.stages.length * 352 : 300);
  const height = layout.height || (direction === 'RIGHT' ? 176 : diagram.stages.length * 172);

  return (
    <section className={styles.diagram} aria-label={`Workflow ${diagram.label}`}>
      <div
        ref={canvasRef}
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
              <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const points = transitionPoints(edge, diagram, nodeById, anchors, direction);
            const isHighlighted = sourceChildIdFor(edge, diagram) === hoveredChildId;
            return (
              <g className={isHighlighted ? styles.edgeActive : styles.edge} key={edge.id}>
                <path d={edgePath(points)} markerEnd="url(#workflow-arrow)" />
              </g>
            );
          })}
        </svg>
        {layout.edges.map((edge) => {
          const point = edgeLabelPoint(
            transitionPoints(edge, diagram, nodeById, anchors, direction),
          );
          const isHighlighted = sourceChildIdFor(edge, diagram) === hoveredChildId;
          return point === undefined || edge.label.length === 0 ? null : (
            <span
              className={`${styles.edgeLabel} ${isHighlighted ? styles.edgeLabelActive : ''}`}
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
          const hasTotals =
            stage.runCount !== undefined ||
            stage.totalDurationMs !== undefined ||
            stage.totalCostUsd !== undefined ||
            stage.totalTokens !== undefined;
          return (
            <div
              className={`${styles.stage} ${boardStyles.card}`}
              ref={(element) => stageRef(stage.id, element)}
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
                  <div className={styles.stageTitleRow}>
                    <strong className={boardStyles.cardTitle}>{stage.label}</strong>
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
                {hasTotals ? (
                  <div className={styles.stageTotals}>
                    {stage.runCount === undefined ? null : <span>{stage.runCount} runs</span>}
                    {stage.totalDurationMs === undefined ? null : (
                      <span>{fmtDuration(stage.totalDurationMs)}</span>
                    )}
                    {stage.totalCostUsd === undefined ? null : (
                      <span>{fmtCost(stage.totalCostUsd)}</span>
                    )}
                    {stage.totalTokens === undefined ? null : tokenUsage(stage)}
                  </div>
                ) : null}
              </div>
              {isExpanded ? (
                <div className={styles.children}>
                  {stage.children.map((child) => (
                    <ChildCard
                      child={child}
                      key={child.id}
                      onHover={direction === 'RIGHT' ? setHoveredChildId : () => undefined}
                    />
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

# Control Plane Analytics Design

**Date:** 2026-07-25
**Issue:** https://github.com/atolis-hq/wake/issues/274

## Purpose

Add a basic Analytics tab to the control-plane UI so operators can understand run volume, outcomes, token usage, duration, and work-item throughput without reading `.wake/runs`, `.wake/state`, and `.wake/events` by hand.

The tab is observability-only. It reads existing durable state and does not add new persisted metrics, counters, or background aggregation.

## Current Context

The control-plane UI is a small static HTML/vanilla JavaScript app served by `src/adapters/http/ui-server.ts` with data builders in `src/adapters/http/ui-data.ts`. Existing UI views already expose status, board, activity, runs, config, and health. Run records already include action, status, timestamps, routing, token usage, and issue/work-item identity. Projections include stage history and issue lifecycle data.

The existing UI spec already reserves `/api/v1/metrics?window=7d` and a "Runs and metrics" concept. This design implements that planned read model as a dedicated, focused Analytics tab.

## User Experience

The Analytics tab shows a compact summary row at the top, then a single selected detail view below it. It must not show every table and chart at once.

Controls:

- Window selector: `1d`, `3d`, `5d`, `7d`.
- Detail view selector: one active analytics view at a time.

Initial detail views:

- `Runs over time`: time-bucketed run counts and status split.
- `Run breakdown`: runs grouped by status, action/stage, repo, runner, model, and tier.
- `Tokens`: token totals grouped by action/stage, runner/model, repo, and day.
- `Duration`: median and average run duration grouped by action/stage and day.
- `Work items`: completed work count and queue-to-done/closed duration where projection timestamps allow it.

The summary row remains visible for every selected detail view and includes:

- total runs
- completed, blocked/awaiting approval, failed counts
- total tokens
- total cost
- median run duration
- completed work items
- median work-item e2e duration

The UI should use simple HTML tables and lightweight CSS bars, not introduce a charting dependency. Time-series detail views use stacked horizontal bars where each day's bar is split by outcome or usage category. Grouped breakdown views use one horizontal proportional bar per row. Bars are proportional within the currently selected view and render as stable-width inline elements so the layout remains readable.

Display rules:

- `Runs over time` uses one stacked bar per time bucket with segments for completed, blocked, awaiting approval, failed, and other runs.
- `Run breakdown` uses sortable-looking tables with a proportional horizontal bar in the count column for each grouping.
- `Tokens` uses one stacked bar per time bucket for input, output, cache creation, and cache read tokens, plus grouped token tables with proportional bars.
- `Duration` uses grouped tables with median duration as the primary bar value and average duration as a secondary number.
- `Work items` uses one bar per time bucket for completed item count and a table of queue-to-done/closed durations.

Time-series granularity:

- `1d` uses hourly buckets for the current day so the chart shows intra-day activity instead of a single bar.
- `3d` uses 6-hour buckets so it shows twelve bars across the three-day window.
- `5d` and `7d` use daily buckets. `7d` shows seven bars, one per calendar day.
- Empty buckets are included with zero values so the selected window keeps a stable shape even when there was no activity.

## API Design

Add:

```text
GET /api/v1/metrics?window=1d|3d|5d|7d
```

The endpoint returns one object containing all aggregate data needed by the Analytics tab for the selected window. This keeps the frontend simple and avoids multiple full run scans per render.

Response shape:

```ts
{
  window: '1d' | '3d' | '5d' | '7d';
  generatedAt: string;
  summary: {
    totalRuns: number;
    completedRuns: number;
    blockedRuns: number;
    awaitingApprovalRuns: number;
    failedRuns: number;
    totalTokens: number;
    totalCostUsd: number;
    medianRunDurationMs?: number;
    completedWorkItems: number;
    medianWorkItemDurationMs?: number;
  };
  runsOverTime: Array<{ bucket: string; label: string; total: number; completed: number; blocked: number; awaitingApproval: number; failed: number; other: number }>;
  runsByStatus: Array<{ key: string; count: number }>;
  runsByAction: Array<{ key: string; count: number }>;
  runsByRepo: Array<{ key: string; count: number }>;
  runsByRunner: Array<{ key: string; count: number }>;
  runsByModel: Array<{ key: string; count: number }>;
  runsByTier: Array<{ key: string; count: number }>;
  tokensOverTime: Array<{ bucket: string; label: string; tokens: number; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; costUsd: number }>;
  tokensByAction: Array<{ key: string; tokens: number; costUsd: number }>;
  tokensByRepo: Array<{ key: string; tokens: number; costUsd: number }>;
  tokensByRunner: Array<{ key: string; tokens: number; costUsd: number }>;
  tokensByModel: Array<{ key: string; tokens: number; costUsd: number }>;
  durationByAction: Array<{ key: string; count: number; averageMs: number; medianMs: number }>;
  durationOverTime: Array<{ bucket: string; label: string; count: number; averageMs: number; medianMs: number }>;
  workItemsOverTime: Array<{ bucket: string; label: string; completed: number }>;
  workItemDurations: Array<{ key: string; repo: string; issueNumber: number; durationMs: number; completedAt: string }>;
}
```

Unknown runner/model/tier values are grouped under `unknown`. Missing token usage counts as zero. Running records without `finishedAt` are excluded from duration aggregates.

## Data Rules

The metrics builder reads:

- `stateStore.listRunRecords()` for run-based aggregates.
- `stateStore.listIssueStates()` for work-item completion and e2e duration.

Window filtering:

- Runs are included when `startedAt` is inside the selected window.
- Work items are included when their completion timestamp is inside the selected window.
- Multi-day windows are inclusive of the current day. For example, `3d` includes today and the previous two calendar days.
- `1d` includes the current local day split into hourly buckets from `00:00` through `23:00`.
- `3d` includes three local calendar days split into 6-hour buckets: `00:00`, `06:00`, `12:00`, and `18:00` for each day.

Run duration:

- `finishedAt - startedAt`.
- Only records with valid `startedAt` and `finishedAt` contribute to duration metrics.

Token total:

- Sum `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, and `cacheReadInputTokens`.

Work-item completion:

- A work item is completed when its stage is terminal or the issue state is closed.
- Completion timestamp is the `done` stage-history entry if present, otherwise issue `updatedAt` for closed issues.
- Start timestamp is issue `createdAt` when present, otherwise the first stage-history timestamp.

## Error Handling

The endpoint tolerates missing run fields and invalid timestamps by skipping only the invalid value from the affected aggregate. It should not fail the entire metrics response because one historical run record lacks optional metadata.

The frontend renders empty states for each selected detail view when the selected window has no data.

## Testing

Add tests before implementation:

- `buildMetrics` aggregates run counts, token totals, cost, and durations for a fixed 7-day window.
- `buildMetrics` groups runner/model/tier metadata from `run.routing` and uses `unknown` for missing values.
- `buildMetrics` computes completed work-item count and median e2e duration from projections.
- `/api/v1/metrics?window=7d` returns the metrics payload.
- Unknown/omitted window defaults to `7d`.
- The static UI includes the Analytics tab, a window selector with `1d`, `3d`, `5d`, `7d`, and code paths for stacked time-bucket bars.

UI rendering remains dependency-free. The server/index test should assert that the static page includes the Analytics tab and calls `/metrics`.

## Non-Goals

- No persisted metrics cache.
- No charting library.
- No mutation controls.
- No external telemetry export.
- No new run-record schema fields.

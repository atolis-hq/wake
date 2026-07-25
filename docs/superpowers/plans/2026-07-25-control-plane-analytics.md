# Control Plane Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a basic Analytics tab to the control-plane UI for run, token, duration, and work-item metrics.

**Architecture:** Add a `buildMetrics` read model in `src/adapters/http/ui-data.ts`, expose it through `GET /api/v1/metrics?window=&metric=`, and render it in the existing static UI. The frontend keeps a summary row visible and renders exactly one selected metric chart/table at a time.

**Tech Stack:** TypeScript, Node HTTP server, vanilla JavaScript/HTML/CSS, Vitest.

---

## File Structure

- Modify `src/adapters/http/ui-data.ts`: add metrics types, parsing, time-bucket helpers, summary aggregation, selected metric detail aggregation, and `buildMetrics`.
- Modify `src/adapters/http/ui-server.ts`: import `buildMetrics` and route `/api/v1/metrics`.
- Modify `src/adapters/http/ui-assets.ts`: add Analytics nav tab, window selector, metric selector, summary tiles, stacked CSS bars, and one-detail renderer.
- Modify `test/adapters/ui-data.test.ts`: add metrics read-model tests.
- Modify `test/adapters/ui-server.test.ts`: add route and static HTML tests.

## Task 1: Metrics Read Model

**Files:**
- Modify: `test/adapters/ui-data.test.ts`
- Modify: `src/adapters/http/ui-data.ts`

- [ ] **Step 1: Write failing selected-metric tests**

Add `buildMetrics` to the existing import list in `test/adapters/ui-data.test.ts`.

Append these tests inside `describe('ui-data', () => { ... })`:

```ts
  it('returns a shared summary and only the selected runs-over-time detail', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-completed',
        issueNumber: 71,
        status: 'completed',
        startedAt: '2026-07-24T10:00:00.000Z',
      }),
      finishedAt: '2026-07-24T10:10:00.000Z',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 5,
        costUsd: 2.5,
      },
    });
    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-failed',
        issueNumber: 72,
        status: 'failed',
        startedAt: '2026-07-25T09:00:00.000Z',
      }),
      finishedAt: '2026-07-25T09:01:00.000Z',
      tokenUsage: { inputTokens: 20, outputTokens: 10, costUsd: 0.25 },
    });

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '7d',
      metric: 'runs-over-time',
    });

    expect(metrics.window).toBe('7d');
    expect(metrics.metric).toBe('runs-over-time');
    expect(metrics.summary).toMatchObject({
      totalRuns: 2,
      completedRuns: 1,
      failedRuns: 1,
      totalTokens: 170,
      totalCostUsd: 2.75,
      medianRunDurationMs: 330000,
    });
    expect(metrics.detail.kind).toBe('runs-over-time');
    expect(metrics.detail.rows).toHaveLength(7);
    expect(metrics.detail.rows.at(-2)).toMatchObject({
      bucket: '2026-07-24',
      label: 'Jul 24',
      total: 1,
      completed: 1,
    });
    expect(metrics.detail.rows.at(-1)).toMatchObject({
      bucket: '2026-07-25',
      label: 'Jul 25',
      total: 1,
      failed: 1,
    });
  });

  it('uses hourly buckets for 1d and 6-hour buckets for 3d', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-hourly',
        issueNumber: 73,
        status: 'completed',
        startedAt: '2026-07-25T09:15:00.000Z',
      }),
      finishedAt: '2026-07-25T09:45:00.000Z',
    });

    const oneDay = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-over-time',
    });
    expect(oneDay.detail.kind).toBe('runs-over-time');
    expect(oneDay.detail.rows).toHaveLength(24);
    expect(oneDay.detail.rows.find((row) => row.bucket === '2026-07-25T09')).toMatchObject({
      label: '09:00',
      total: 1,
    });

    const threeDay = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '3d',
      metric: 'runs-over-time',
    });
    expect(threeDay.detail.kind).toBe('runs-over-time');
    expect(threeDay.detail.rows).toHaveLength(12);
    expect(threeDay.detail.rows.find((row) => row.bucket === '2026-07-25T06')).toMatchObject({
      label: 'Jul 25 06:00',
      total: 1,
    });
  });

  it('groups only the selected runner metric and resolves models from config when requested', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.runners['codex-main'] = {
      kind: 'codex',
      command: 'codex',
      model: 'gpt-5.5',
      smokeModel: 'gpt-5.4-mini',
      smokePrompt: 'hi',
      timeoutMs: 1000,
      models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
    };

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-known',
        issueNumber: 74,
        status: 'completed',
        startedAt: '2026-07-25T08:00:00.000Z',
      }),
      routing: {
        runnerName: 'codex-main',
        runnerKind: 'codex',
        tier: 'standard',
        reason: 'test',
      },
    });
    await store.writeRunRecord(
      runRecord({
        runId: 'run-unknown',
        issueNumber: 75,
        status: 'completed',
        startedAt: '2026-07-25T09:00:00.000Z',
      }),
    );

    const byRunner = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-runner',
    });
    expect(byRunner.detail).toEqual({
      kind: 'run-counts',
      group: 'runner',
      rows: [
        { key: 'codex-main', count: 1 },
        { key: 'unknown', count: 1 },
      ],
    });

    const byModel = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-model',
    });
    expect(byModel.detail).toEqual({
      kind: 'run-counts',
      group: 'model',
      rows: [
        { key: 'gpt-5.5', count: 1 },
        { key: 'unknown', count: 1 },
      ],
    });
  });

  it('computes completed work-item e2e duration only for selected work-item detail metrics', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    const base = issueState({ number: 81, stage: 'done' });

    await store.writeIssueState({
      ...base,
      issue: {
        ...base.issue,
        createdAt: '2026-07-25T09:00:00.000Z',
        updatedAt: '2026-07-25T11:00:00.000Z',
      },
      wake: {
        ...base.wake,
        syncedAt: '2026-07-25T11:00:00.000Z',
        stageHistory: [
          { stage: 'queue', changedAt: '2026-07-25T09:00:00.000Z', reason: 'test' },
          { stage: 'done', changedAt: '2026-07-25T11:00:00.000Z', reason: 'test' },
        ],
      },
    });

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'work-item-durations',
    });

    expect(metrics.summary.completedWorkItems).toBe(1);
    expect(metrics.summary.medianWorkItemDurationMs).toBe(7200000);
    expect(metrics.detail).toEqual({
      kind: 'work-item-durations',
      rows: [
        {
          key: workId(81),
          repo: 'atolis-hq/wake',
          issueNumber: 81,
          durationMs: 7200000,
          completedAt: '2026-07-25T11:00:00.000Z',
        },
      ],
    });
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run test/adapters/ui-data.test.ts -t "selected|hourly|runner metric|e2e duration"
```

Expected: FAIL because `buildMetrics` is not exported.

- [ ] **Step 3: Implement minimal metrics read model**

In `src/adapters/http/ui-data.ts`, add:

- `export type MetricsWindow = '1d' | '3d' | '5d' | '7d';`
- `export type MetricsMetric = ...` with the metric IDs from the spec.
- `export async function buildMetrics(input: { stateStore: StateStore; config: WakeConfig; now: Date; window?: string; metric?: string })`

Implementation requirements:

- Default unknown/omitted `window` to `7d`.
- Default unknown/omitted `metric` to `runs-over-time`.
- Compute summary from runs in the selected window and completed work items in the selected window.
- Include empty time buckets for every bucket in the selected window.
- Use local date parts from `Date` instances consistently with the process timezone.
- Group unknown runner/model/tier as `unknown`.
- Resolve model from `config.runners[run.routing.runnerName]` for non-fake runners.
- Return only the selected `detail` union, never all metric detail arrays.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npx vitest run test/adapters/ui-data.test.ts -t "selected|hourly|runner metric|e2e duration"
```

Expected: PASS.

## Task 2: Metrics API Route

**Files:**
- Modify: `test/adapters/ui-server.test.ts`
- Modify: `src/adapters/http/ui-server.ts`

- [ ] **Step 1: Write failing API and HTML tests**

In `test/adapters/ui-server.test.ts`, add a test near the status/board API test:

```ts
  it('serves selected analytics metrics under /api/v1/metrics', async () => {
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-metrics',
      workItemKey: workId(91),
      repo: 'atolis-hq/wake',
      issueNumber: 91,
      action: 'implement',
      status: 'completed',
      startedAt: '2026-07-25T10:00:00.000Z',
      finishedAt: '2026-07-25T10:01:00.000Z',
      tokenUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
    });

    const res = await fetch(`${baseUrl}/api/v1/metrics?window=1d&metric=tokens-over-time`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: string;
      metric: string;
      summary: { totalRuns: number; totalTokens: number };
      detail: { kind: string; rows: Array<{ tokens: number }> };
    };
    expect(body.window).toBe('1d');
    expect(body.metric).toBe('tokens-over-time');
    expect(body.summary.totalRuns).toBe(1);
    expect(body.summary.totalTokens).toBe(15);
    expect(body.detail.kind).toBe('tokens-over-time');
  });
```

In the existing static index test, add:

```ts
    expect(html).toContain('data-view="analytics"');
    expect(html).toContain('/metrics?window=');
    expect(html).toContain('&metric=');
```

- [ ] **Step 2: Run route tests to verify RED**

Run:

```bash
npx vitest run test/adapters/ui-server.test.ts -t "metrics|static index"
```

Expected: FAIL because the route and static UI are missing.

- [ ] **Step 3: Add `/metrics` route**

In `src/adapters/http/ui-server.ts`:

- Add `buildMetrics` to the import list from `./ui-data.js`.
- Add this GET branch before the final 404:

```ts
  if (resource === 'metrics' && segments.length === 1) {
    sendJson(
      res,
      200,
      await buildMetrics({
        stateStore,
        config,
        now: now(),
        window: url.searchParams.get('window') ?? undefined,
        metric: url.searchParams.get('metric') ?? undefined,
      }),
    );
    return;
  }
```

- [ ] **Step 4: Run API test to verify route GREEN**

Run:

```bash
npx vitest run test/adapters/ui-server.test.ts -t "serves selected analytics metrics"
```

Expected: PASS.

## Task 3: Analytics Frontend Tab

**Files:**
- Modify: `test/adapters/ui-server.test.ts`
- Modify: `src/adapters/http/ui-assets.ts`

- [ ] **Step 1: Confirm static HTML test is RED**

Run:

```bash
npx vitest run test/adapters/ui-server.test.ts -t "static index"
```

Expected: FAIL because the static page lacks the Analytics tab and selected metric fetch.

- [ ] **Step 2: Add nav, selector state, and styles**

In `src/adapters/http/ui-assets.ts`:

- Add `<button data-view="analytics">Analytics</button>` between Runs and Config.
- Add module-level variables:

```js
let analyticsWindow = '7d';
let analyticsMetric = 'runs-over-time';
```

- Add styles for `.toolbar`, `select`, `.metric-bar`, `.metric-bar-fill`, `.stacked-bar`, `.stacked-segment`, and `.metric-table-value`.

- [ ] **Step 3: Add Analytics renderers**

Add JavaScript helpers:

```js
const METRIC_OPTIONS = [
  ['runs-over-time', 'Runs over time'],
  ['runs-by-status', 'Runs by status'],
  ['runs-by-action', 'Runs by action/stage'],
  ['runs-by-repo', 'Runs by repo'],
  ['runs-by-runner', 'Runs by runner'],
  ['runs-by-model', 'Runs by model'],
  ['runs-by-tier', 'Runs by tier'],
  ['tokens-over-time', 'Tokens over time'],
  ['tokens-by-action', 'Tokens by action/stage'],
  ['tokens-by-runner', 'Tokens by runner'],
  ['tokens-by-model', 'Tokens by model'],
  ['duration-by-action', 'Duration by action/stage'],
  ['duration-over-time', 'Duration over time'],
  ['work-items-over-time', 'Work items completed over time'],
  ['work-item-durations', 'Work item e2e duration'],
];

function fmtNumber(value) { return Number(value || 0).toLocaleString(); }
function fmtDuration(ms) { return ms === undefined || ms === null ? '' : fmtMs(ms); }
function selectedOption(value, current) { return value === current ? { selected: 'selected' } : {}; }
```

Add `renderAnalytics()` that:

- Fetches `/metrics?window=` plus `analyticsWindow` plus `&metric=` plus `analyticsMetric`.
- Renders the two selectors.
- Renders summary tiles.
- Dispatches on `metrics.detail.kind` and renders one selected detail only.

Add detail renderers:

- Stacked rows for `runs-over-time` and `tokens-over-time`.
- Count table for `run-counts`.
- Token table for `token-counts`.
- Duration table for `durations` and `duration-over-time`.
- Work-item rows for `work-items-over-time` and `work-item-durations`.

Add `analytics: renderAnalytics` to the `renderers` object.

- [ ] **Step 4: Run static HTML test to verify GREEN**

Run:

```bash
npx vitest run test/adapters/ui-server.test.ts -t "static index"
```

Expected: PASS.

## Task 4: Verification and Formatting

**Files:**
- All touched files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run test/adapters/ui-data.test.ts test/adapters/ui-server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Format touched files**

Run:

```bash
npx prettier --write --end-of-line lf src/adapters/http/ui-data.ts src/adapters/http/ui-server.ts src/adapters/http/ui-assets.ts test/adapters/ui-data.test.ts test/adapters/ui-server.test.ts docs/superpowers/plans/2026-07-25-control-plane-analytics.md
```

Expected: Prettier completes successfully.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run verify
```

Expected: PASS, except known CRLF-only `format:check` false positives on untouched files. If a touched file is reported, rerun Step 2 and then rerun `npm run verify`.

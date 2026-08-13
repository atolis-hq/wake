# Board duration display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show run count, last-run recency, total run duration, cost, and
tokens on the board card stats line; give the active-run child card
second-level elapsed-time granularity; keep both current via the board's
existing poll (no client-side ticking or clock diffing); and give every
duration display in the app the same seconds-through-days granularity.

**Architecture:** All "how long ago" / "how long did this take" math moves
server-side: the board projection accumulates `totalDurationMs` from
already-recorded event timestamps, and the board application layer computes
`lastRunAgeMs` / `activeRun.elapsedMs` once per response using its existing
`now()`. The client never diffs a timestamp against its own clock — it only
formats numbers the API sends. A single shared formatter (`fmtDuration`)
renders every duration in the app with one granularity scheme.

**Tech Stack:** TypeScript, Vitest, React (board card), hand-rolled
formatting (no date/duration library — see rationale below).

## Global Constraints

- Every duration display in the app uses the same granularity rules (spec
  requirement 4): `< 10s` → exact seconds (`7s`); `10s–59s` → nearest 10s,
  floor, minimum `10s` (`40s`); `1m–59m` → floor minutes (`12m`); `1h–23h59m`
  → hours + minutes (`1h5m`); `≥ 24h` → floor days (`2d`). No milliseconds
  ever. `1s` is the lowest value any positive duration can display (values
  under 1000ms round up to `1s`, never `0s`).
- No new npm dependency for duration formatting — the web package
  (`src-next/surfaces/web/package.json`) currently has zero date/duration
  libraries, and the specific staged-granularity scheme above isn't what any
  standard humanizer outputs directly, so a hand-rolled function (extending
  the existing `fmtDuration`) stays consistent with the codebase's current
  approach in this package.
- No client-side ticking components. Liveness comes entirely from values the
  API recomputes on each request, surfaced via the board list's existing 3s
  poll (`refreshPolicy.board`, `src-next/surfaces/web/src/features/board/board.tsx:39`).
- Follow this repo's `npm run verify:next` gate (contracts lint,
  architecture lint, knip, full `src-next` build + tests) before treating any
  task as done — see Task 5.

---

## Current state (read this before starting)

The working tree already has **uncommitted, unrelated in-progress changes**
to several files this plan touches:
`src-next/bootstrap/board-projection.ts`,
`src-next/bootstrap/surface-api-applications.ts`,
`src-next/surfaces/api/contracts/board.ts`,
`src-next/surfaces/web/src/api/decoders.ts`, and
`src-next/surfaces/web/src/features/board/board-card.tsx`. That work adds
`lastRunOutcome`, a `terminalRunFields` helper, `cardRecency`-based sorting,
and new status-badge icons to the board card — none of it is part of this
plan, and none of it should be reverted. Every task below is written against
the *current* content of these files (as of writing this plan), not their
last-committed version. Read each file with the `Read` tool immediately
before editing it, rather than assuming the git history reflects its
contents.

---

### Task 1: Shared duration formatter

**Files:**
- Modify: `src-next/surfaces/web/src/components/format.ts`
- Test: `src-next/surfaces/web/test/format.test.ts` (new file)

**Interfaces:**
- Produces: `fmtDuration(ms: number): string` — same name and signature as
  today, new bucket behavior. `fmtAge` is removed (no longer needed —
  callers get a precomputed `ms` value from the API instead of a timestamp
  to diff).

- [ ] **Step 1: Write the failing tests**

Create `src-next/surfaces/web/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../src/components/format.js';

describe('fmtDuration', () => {
  it('shows exact seconds under 10s', () => {
    expect(fmtDuration(1)).toBe('1s');
    expect(fmtDuration(999)).toBe('1s');
    expect(fmtDuration(1_000)).toBe('1s');
    expect(fmtDuration(7_000)).toBe('7s');
    expect(fmtDuration(9_999)).toBe('9s');
  });

  it('rounds down to the nearest 10s between 10s and 59s', () => {
    expect(fmtDuration(10_000)).toBe('10s');
    expect(fmtDuration(14_999)).toBe('10s');
    expect(fmtDuration(40_000)).toBe('40s');
    expect(fmtDuration(59_999)).toBe('50s');
  });

  it('shows floor minutes between 1m and 59m', () => {
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(12 * 60_000 + 45_000)).toBe('12m');
    expect(fmtDuration(59 * 60_000 + 59_000)).toBe('59m');
  });

  it('shows hours and minutes between 1h and 24h', () => {
    expect(fmtDuration(60 * 60_000)).toBe('1h0m');
    expect(fmtDuration(60 * 60_000 + 5 * 60_000)).toBe('1h5m');
    expect(fmtDuration(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h59m');
  });

  it('shows floor days at 24h and beyond', () => {
    expect(fmtDuration(24 * 60 * 60_000)).toBe('1d');
    expect(fmtDuration(2 * 24 * 60 * 60_000 + 5 * 60 * 60_000)).toBe('2d');
  });

  it('returns an empty string for non-finite or negative input', () => {
    expect(fmtDuration(-1)).toBe('');
    expect(fmtDuration(Number.NaN)).toBe('');
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src-next/surfaces/web/test/format.test.ts`
Expected: FAIL — today's `fmtDuration` returns `'<1m'` for anything under a
minute, so every "exact seconds" and "nearest 10s" assertion above fails.

- [ ] **Step 3: Replace `fmtDuration` and remove `fmtAge`**

Replace the full contents of
`src-next/surfaces/web/src/components/format.ts` with:

```ts
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export function fmtCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.max(1, Math.floor(ms / 1_000));
  if (totalSeconds < 10) return `${totalSeconds}s`;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds / 10) * 10}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h${totalMinutes % 60}m`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}
```

This drops `fmtAge` entirely — its only caller is updated in Task 4 to use
`fmtDuration` directly on a server-provided `elapsedMs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src-next/surfaces/web/test/format.test.ts`
Expected: PASS (all cases green)

- [ ] **Step 5: Find and fix other `fmtAge` callers**

Run: `grep -rn "fmtAge" src-next/surfaces/web/src` — this should currently
only match `board-card.tsx`. Leave that call site alone for now; it's fixed
in Task 4 as part of the board-card change (changing it here would leave the
board card referencing a field, `elapsedMs`, that doesn't exist on the type
yet, so the type-check would fail prematurely). If the grep turns up any
other caller, stop and re-scope this step before continuing — this plan
assumes exactly one call site.

- [ ] **Step 6: Commit**

```bash
git add src-next/surfaces/web/src/components/format.ts src-next/surfaces/web/test/format.test.ts
git commit -m "feat(web): give fmtDuration second-level granularity"
```

---

### Task 2: `totalDurationMs` on the board projection

**Files:**
- Modify: `src-next/bootstrap/board-projection.ts`
- Modify: `src-next/surfaces/api/contracts/board.ts`
- Test: `test-next/unit/bootstrap/board-projection.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `StoredCard.totalDurationMs: number` and
  `BoardCardResponse.totalDurationMs: number` — Task 3 reads
  `card.totalDurationMs` off the projection when building API responses;
  Task 5 (decoder) and Task 6 (board card) consume
  `BoardCardResponse.totalDurationMs`.

- [ ] **Step 1: Read the current files**

Read `src-next/bootstrap/board-projection.ts` and
`src-next/surfaces/api/contracts/board.ts` in full before editing — per the
"Current state" note above, both already differ from their last commit
(the projection already has `terminalRunFields`, `lastRunOutcome`,
`lookupWorkflowCard`, etc.; the contract already has `lastRunOutcome`).

- [ ] **Step 2: Write the failing test**

Open `test-next/unit/bootstrap/board-projection.test.ts`. In the second
`it` block (`'shows an active run, accumulates token/cost totals, and
clears the run on completion'`), extend the two existing assertions after
the `finished` projection is computed:

```ts
    expect(finished.cards[item]!.activeRun).toBeUndefined();
    expect(finished.cards[item]).toMatchObject({
      totalTokens: 35,
      totalCostUsd: 0.03,
      totalDurationMs: 300_000,
    });
```

(300_000ms = the 5 minutes between the test's `startedAt:
'2026-08-03T12:00:00.000Z'` on `RunStarted` and `finishedAt:
'2026-08-03T12:05:00.000Z'` on the `RunSucceeded` event three lines above.)

Also extend the third `it` block
(`'moves a card to error and clears the active run when the agent reports a
failed outcome'`), which uses the same `startedAt`/`finishedAt` pair:

```ts
    expect(failed.cards[item]).toMatchObject({
      condition: 'error',
      lastRunOutcome: 'failed',
      totalDurationMs: 300_000,
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test-next/unit/bootstrap/board-projection.test.ts`
Expected: FAIL — `totalDurationMs` is `undefined` on both cards (the field
doesn't exist yet).

- [ ] **Step 4: Add `totalDurationMs` to the contract**

In `src-next/surfaces/api/contracts/board.ts`, add the field to
`BoardCardResponse` next to the existing `totalTokens`/`totalCostUsd`
fields:

```ts
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
```

- [ ] **Step 5: Add `totalDurationMs` to `StoredCard` and initialise it**

In `src-next/bootstrap/board-projection.ts`, add the field to the
`StoredCard` interface next to `totalTokens`/`totalCostUsd`:

```ts
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
```

In `projectWork`, the `ItemCreated` branch builds the initial `card` object
— add `totalDurationMs: 0` next to the existing `totalTokens: 0,
totalCostUsd: 0,`.

- [ ] **Step 6: Accumulate duration on run-terminal events**

Add a helper next to the existing `terminalRunFields` function (same file):

```ts
function terminalFinishedAt(
  event: ReturnType<typeof selectRunExecutionEvent> & {},
): string | undefined {
  switch (event.eventType) {
    case ExecutionEventType.RunSucceeded:
    case ExecutionEventType.RunFailed:
    case ExecutionEventType.RunCancelled:
    case ExecutionEventType.RunAmbiguous:
      return event.payload.finishedAt;
    default:
      return undefined;
  }
}
```

Then update the terminal branch inside `projectRun` (currently reads
`{ ...withoutActiveRun(card), ...terminalRunFields(event) }`) to also merge
in the accumulated duration, computed from the *current* card (before
`withoutActiveRun` strips `activeRun`):

```ts
  if (runTerminalEventTypes.has(event.eventType)) {
    const finishedAt = terminalFinishedAt(event);
    const runDurationMs =
      finishedAt === undefined || card.activeRun === undefined
        ? 0
        : Date.parse(finishedAt) - Date.parse(card.activeRun.startedAt);
    return {
      ...view,
      cards: {
        ...view.cards,
        [workId]: {
          ...withoutActiveRun(card),
          ...terminalRunFields(event),
          totalDurationMs: card.totalDurationMs + runDurationMs,
        },
      },
    };
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test-next/unit/bootstrap/board-projection.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src-next/bootstrap/board-projection.ts src-next/surfaces/api/contracts/board.ts test-next/unit/bootstrap/board-projection.test.ts
git commit -m "feat(bootstrap): accumulate total run duration on the board projection"
```

---

### Task 3: `lastRunAgeMs` and `activeRun.elapsedMs` at response time

**Files:**
- Modify: `src-next/surfaces/api/contracts/board.ts`
- Modify: `src-next/bootstrap/surface-api-applications.ts`
- Test: `test-next/unit/bootstrap/board-card-elapsed.test.ts` (new file) —
  the server-clock math is pulled out into a small exported pure function,
  `elapsedSince`, specifically so it's unit-testable without a full
  composition-root fixture (no existing test in this repo exercises
  `createBoardApplications.list()` directly against a real composition
  root; see Step 2 below).

**Interfaces:**
- Consumes: `StoredCard` (from Task 2, now including `totalDurationMs`),
  the `now: () => string` already threaded through
  `createSurfaceApiApplications` / `createBoardApplications`.
- Produces: `BoardCardResponse.lastRunAgeMs?: number`,
  `BoardCardActiveRun.elapsedMs: number` — Task 5 (decoder) and Task 6
  (board card) consume both. Also produces `elapsedSince(timestamp: string,
  nowMs: number): number`, a small exported pure helper — nothing later
  depends on its name, it exists purely to keep the response-time math unit
  testable without a full composition-root fixture.

- [ ] **Step 1: Add the fields to the contract**

In `src-next/surfaces/api/contracts/board.ts`:

```ts
export interface BoardCardActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
}

export interface BoardCardResponse {
  // ...existing fields, unchanged...
  readonly lastRunAt?: string;
  readonly lastRunAgeMs?: number;
  readonly lastRunOutcome?: string;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly externalRef?: string;
}
```

(Insert `lastRunAgeMs` immediately after `lastRunAt` and before
`lastRunOutcome`, matching the existing field ordering style.)

- [ ] **Step 2: Write the failing test**

Read `src-next/bootstrap/surface-api-applications.ts` in full first — recall
from the "Current state" note that it already differs from its last commit
(it already has `cardRecency`, `recentEvents`, etc.).

Create `test-next/unit/bootstrap/board-card-elapsed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { elapsedSince } from '../../../src-next/bootstrap/surface-api-applications.js';

describe('elapsedSince', () => {
  it('returns the millisecond gap between a timestamp and a later clock reading', () => {
    const nowMs = Date.parse('2026-08-03T12:10:00.000Z');
    expect(elapsedSince('2026-08-03T12:05:00.000Z', nowMs)).toBe(5 * 60_000);
    expect(elapsedSince('2026-08-03T12:08:00.000Z', nowMs)).toBe(2 * 60_000);
    expect(elapsedSince('2026-08-03T12:10:00.000Z', nowMs)).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test-next/unit/bootstrap/board-card-elapsed.test.ts`
Expected: FAIL — `elapsedSince` is not exported (doesn't exist yet).

- [ ] **Step 4: Add and export `elapsedSince`, and wire it into `list()`**

In `src-next/bootstrap/surface-api-applications.ts`, add a new exported
function (place it near `cardRecency`, which is defined near the bottom of
the file):

```ts
export function elapsedSince(timestamp: string, nowMs: number): number {
  return nowMs - Date.parse(timestamp);
}
```

Then, in `createBoardApplications`'s `list()` method, use it to enrich each
card before presenting. The current body reads:

```ts
      const items = await Promise.all(
        page.map(async (card) => {
          const externalRef = await primaryExternalRef(root, card.workItemId);
          return presentBoardCard(externalRef === undefined ? card : { ...card, externalRef });
        }),
      );
```

Change it to compute `nowMs` once per request and merge in
`lastRunAgeMs`/`activeRun.elapsedMs` for each card:

```ts
      const nowMs = Date.parse(now());
      const items = await Promise.all(
        page.map(async (card) => {
          const externalRef = await primaryExternalRef(root, card.workItemId);
          const withExternalRef = externalRef === undefined ? card : { ...card, externalRef };
          return presentBoardCard({
            ...withExternalRef,
            ...(withExternalRef.lastRunAt === undefined
              ? {}
              : { lastRunAgeMs: elapsedSince(withExternalRef.lastRunAt, nowMs) }),
            ...(withExternalRef.activeRun === undefined
              ? {}
              : {
                  activeRun: {
                    ...withExternalRef.activeRun,
                    elapsedMs: elapsedSince(withExternalRef.activeRun.startedAt, nowMs),
                  },
                }),
          });
        }),
      );
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test-next/unit/bootstrap/board-card-elapsed.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-next/bootstrap/surface-api-applications.ts src-next/surfaces/api/contracts/board.ts test-next/unit/bootstrap/board-card-elapsed.test.ts
git commit -m "feat(bootstrap): compute board card elapsed times server-side from now()"
```

---

### Task 4: Decode the new fields on the client

**Files:**
- Modify: `src-next/surfaces/web/src/api/decoders.ts`

**Interfaces:**
- Consumes: `BoardCardResponse.totalDurationMs`, `.lastRunAgeMs`,
  `BoardCardActiveRun.elapsedMs` (Tasks 2 and 3).
- Produces: nothing new — this task makes the existing `decodeBoardCard` /
  `decodeBoardCardActiveRun` decoders accept and pass through the 3 new
  response fields, which Task 5 then renders.

- [ ] **Step 1: Read the current file**

Read `src-next/surfaces/web/src/api/decoders.ts` in full — it's already
mid-refactor per the "Current state" note (import ordering changed).
`decodeBoardCard` is around line 129, `decodeBoardCardActiveRun` around
line 151 as of this writing, but confirm exact line numbers before editing.

- [ ] **Step 2: Update `decodeBoardCard`**

Add `totalDurationMs` (required) next to the existing
`totalTokens`/`totalCostUsd` lines, and `lastRunAgeMs` (optional) next to
the existing `optionalStringProperty(record, 'lastRunAt', path)` line:

```ts
    ...optionalStringProperty(record, 'lastRunAt', path),
    ...optionalNumberProperty(record, 'lastRunAgeMs', path),
    totalTokens: number(record.totalTokens, child(path, 'totalTokens')),
    totalCostUsd: number(record.totalCostUsd, child(path, 'totalCostUsd')),
    totalDurationMs: number(record.totalDurationMs, child(path, 'totalDurationMs')),
```

- [ ] **Step 3: Update `decodeBoardCardActiveRun`**

Add `elapsedMs` (required) to the returned object:

```ts
function decodeBoardCardActiveRun(
  value: unknown,
  path: string,
): NonNullable<BoardCardResponse['activeRun']> {
  const record = object(value, path);
  return {
    action: string(record.action, child(path, 'action')),
    startedAt: string(record.startedAt, child(path, 'startedAt')),
    elapsedMs: number(record.elapsedMs, child(path, 'elapsedMs')),
    ...optionalStringProperty(record, 'runnerName', path),
  };
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p src-next/surfaces/web/tsconfig.json` (check the
actual tsconfig path under `src-next/surfaces/web` first — use whichever
config the package's own `build` script in
`src-next/surfaces/web/package.json` invokes, i.e. `tsc --noEmit && vite
build`, and run just the `tsc --noEmit` half)
Expected: no new errors from `decoders.ts`. This step is a compile check,
not a test run — the actual behavioral coverage for these decoders comes
from the board E2E tests updated in Task 6, since there's no standalone
decoder test file for board cards today (confirmed by search — don't add
one here; follow the existing pattern of testing decoders through the
E2E/board tests that exercise the real client).

- [ ] **Step 5: Commit**

```bash
git add src-next/surfaces/web/src/api/decoders.ts
git commit -m "feat(web): decode board card duration fields"
```

---

### Task 5: Board card rendering

**Files:**
- Modify: `src-next/surfaces/web/src/features/board/board-card.tsx`
- Modify: `src-next/surfaces/web/test/board.test.tsx`
- Modify: `src-next/surfaces/web/test/app.test.tsx`
- Modify: `src-next/surfaces/web/test/collections.test.tsx`
- Modify: `src-next/surfaces/web/e2e/surface-fixture.ts`

**Interfaces:**
- Consumes: `item.runCount`, `item.lastRunAgeMs`, `item.totalDurationMs`,
  `item.totalCostUsd`, `item.totalTokens`, `item.activeRun.elapsedMs` (all
  from Tasks 2–4).
- Produces: nothing consumed by later tasks — this is the leaf UI change.

- [ ] **Step 1: Read the current file**

Read `src-next/surfaces/web/src/features/board/board-card.tsx` in full — per
the "Current state" note, it already has `StatusBadge`, `outcomeTone`, and
several inline icon components (`OutcomeIcon`, `ApprovalIcon`,
`WorkflowIcon`, `StageIcon`) ahead of the `BoardCard` export. This task only
touches the stats line (`cardStats`) and the active-run meta line
(`childRunMeta`) inside `BoardCard`; leave everything else in the file
untouched.

- [ ] **Step 2: Write the failing test**

In `src-next/surfaces/web/test/board.test.tsx`, add `totalDurationMs: 0` to
every item literal in `boardClient()` (three items) and in the
`awaiting approval` test's single item literal — the decoder now requires
it. Also add `lastRunAt` and a corresponding age to the first item so the
new "last run" text has something to assert on. Change the first item in
`boardClient()`'s `items` array from:

```ts
    {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      condition: 'ready',
      workflowName: 'delivery',
      stage: 'implement',
      dwellSince: asOf,
      runCount: 1,
      totalTokens: 0,
      totalCostUsd: 0,
    },
```

to:

```ts
    {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      condition: 'ready',
      workflowName: 'delivery',
      stage: 'implement',
      dwellSince: asOf,
      runCount: 1,
      lastRunAt: asOf,
      lastRunAgeMs: 125_000,
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 300_000,
    },
```

and add `totalDurationMs: 0` to the other two items in that array, and to
the single item in the `'shows an awaiting approval status...'` test.

Add a new test asserting the rendered stats line, after the existing
`'renders each card as a link to its work item key route'` test:

```ts
  it('shows run count, last-run recency, total duration, cost, and tokens on the stats line', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('listitem', { name: 'Alpha' });
    expect(
      within(card).getByText('1 runs · last run 2m ago · 5m total · $0.0000 · 0 tokens'),
    ).toBeTruthy();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src-next/surfaces/web/test/board.test.tsx`
Expected: FAIL — the current stats line text is `"1 runs · since
2026-07-31T10:00:00.000Z · $0.00 · 0 tokens"`, and `totalDurationMs`/
`lastRunAgeMs` aren't decoded/rendered yet.

- [ ] **Step 4: Update the stats line and active-run meta**

In `src-next/surfaces/web/src/features/board/board-card.tsx`, find the
`cardStats` span (currently: `` {`${item.runCount} runs · since
${item.dwellSince} · ${fmtCost(item.totalCostUsd)} ·
${fmtCompact(item.totalTokens)} tokens`} ``) and replace it with:

```tsx
        <span className={styles.cardStats}>
          {`${item.runCount} runs · ${
            item.lastRunAgeMs === undefined
              ? 'no runs yet'
              : `last run ${fmtDuration(item.lastRunAgeMs)} ago`
          } · ${fmtDuration(item.totalDurationMs)} total · ${fmtCost(item.totalCostUsd)} · ${fmtCompact(item.totalTokens)} tokens`}
        </span>
```

Find the active-run meta line (currently uses `fmtAge`):

```tsx
              <div className={styles.childRunMeta}>
                {[item.activeRun.runnerName, fmtAge(item.activeRun.startedAt)]
                  .filter((part): part is string => part !== undefined)
                  .join(' · ')}
              </div>
```

Change `fmtAge(item.activeRun.startedAt)` to
`fmtDuration(item.activeRun.elapsedMs)`.

Update the import line at the top of the file from
`import { fmtAge, fmtCompact, fmtCost } from '../../components/format.js';`
to
`import { fmtCompact, fmtCost, fmtDuration } from '../../components/format.js';`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src-next/surfaces/web/test/board.test.tsx`
Expected: PASS

- [ ] **Step 6: Fix the other board fixtures the decoder now rejects**

Run: `npx vitest run` (full web test suite) — this surfaces every other
fixture missing `totalDurationMs`. Expected failures and fixes:

In `src-next/surfaces/web/test/app.test.tsx`, around line 138-148, change:

```ts
              ? items.map((item) => ({
                  workItemKey: item.workItemKey,
                  workItemId: item.workItemId,
                  objective: item.objective,
                  condition: 'ready',
                  dwellSince: asOf,
                  runCount: 0,
                  totalTokens: 0,
                  totalCostUsd: 0,
                }))
```

to:

```ts
              ? items.map((item) => ({
                  workItemKey: item.workItemKey,
                  workItemId: item.workItemId,
                  objective: item.objective,
                  condition: 'ready',
                  dwellSince: asOf,
                  runCount: 0,
                  totalTokens: 0,
                  totalCostUsd: 0,
                  totalDurationMs: 0,
                }))
```

In `src-next/surfaces/web/test/collections.test.tsx`, around line 55-64,
change the `'work'` branch's item literal:

```ts
            {
              workItemKey: 'wk_demo',
              workItemId: 'work-demo',
              objective: 'Demo Wake',
              condition: 'ready',
              dwellSince: asOf,
              runCount: 1,
              totalTokens: 0,
              totalCostUsd: 0,
            },
```

to:

```ts
            {
              workItemKey: 'wk_demo',
              workItemId: 'work-demo',
              objective: 'Demo Wake',
              condition: 'ready',
              dwellSince: asOf,
              runCount: 1,
              totalTokens: 0,
              totalCostUsd: 0,
              totalDurationMs: 0,
            },
```

The `'runs'` branch's item literal (the one with `runId: 'run-1'`,
`totalTokens: 0` around line 78) is a `RunResponse`, not a
`BoardCardResponse` — it needs no change.

In `src-next/surfaces/web/e2e/surface-fixture.ts`, the `board.list()`
method builds items without `totalTokens`/`totalCostUsd` at all today (a
pre-existing gap, out of scope to fix) — add `totalDurationMs: 0` to the
mapped object anyway, next to `runCount: 0,`, so this fixture doesn't get
further out of sync with the contract:

```ts
      const items = workItems().map((work) => ({
        workItemKey: work.workItemKey,
        workItemId: work.workItemId,
        objective: work.objective,
        condition:
          work.state === WorkStatus.Closed || work.state === WorkStatus.Cancelled
            ? 'finished'
            : ('ready' as const),
        dwellSince: instant,
        runCount: 0,
        totalDurationMs: 0,
      }));
```

Re-run: `npx vitest run`
Expected: PASS across the whole web test suite.

- [ ] **Step 7: Commit**

```bash
git add src-next/surfaces/web/src/features/board/board-card.tsx src-next/surfaces/web/test/board.test.tsx src-next/surfaces/web/test/app.test.tsx src-next/surfaces/web/test/collections.test.tsx src-next/surfaces/web/e2e/surface-fixture.ts
git commit -m "feat(web): show last-run recency and total duration on board cards"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full `src-next` verification gate**

Run: `npm run verify:next`
Expected: PASS — this runs `lint:contracts`, `lint:architecture`, lint,
format check, build, and every `src-next` test (including the
`test-next/unit/bootstrap/*` and `src-next/surfaces/web/test/*` suites
touched above).

If it fails on architecture/contract lint because of the new
`totalDurationMs`/`lastRunAgeMs`/`elapsedMs` fields being compared or
constructed in a way that trips a magic-string/open-payload rule, re-read
the specific lint error — these are plain numeric fields on an already
`export interface`-declared contract, so no new violation is expected, but
confirm before treating this as done.

- [ ] **Step 2: Run knip**

Run: `npm run knip:next`
Expected: PASS — confirms `fmtAge`'s removal didn't leave a dangling export
reference, and that `elapsedSince` (now exported) isn't flagged as unused
(it's consumed both by `surface-api-applications.ts`'s own `list()` and
imported by the new `board-card-elapsed.test.ts`).

- [ ] **Step 3: Manually confirm in the running app (optional but recommended)**

Run: `npm run start` (or whatever this repo's dev script is for the web UI
— check `src-next/surfaces/web/package.json` and the root `package.json`
scripts if `npm run start` doesn't serve the web UI directly) and load the
board. Confirm: a card with run history shows `"N runs · last run Xm ago ·
Ym total · $cost · N tokens"`; a card with no runs shows `"0 runs · no runs
yet · ..."`; an active-run child card shows a duration like `7s`/`40s`/`3m`
that changes on the board's next 3s poll without a page reload.

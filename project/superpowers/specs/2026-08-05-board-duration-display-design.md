# Board duration display design

## Context

The operator board (`src-next` web UI) shows per-work-item cards with a run
stats line and, for items with an in-flight run, a child "active run" card.
Today:

- The stats line reads `"{runCount} runs · since {dwellSince} · {cost} ·
  {tokens}"` — `dwellSince` is the stage-entry timestamp, not run history, so
  it's a confusing thing to show next to run count.
- The active-run child card shows elapsed time via `fmtAge(startedAt)`, which
  diffs an API timestamp against the browser's `Date.now()`.
- `fmtDuration` only has minute-or-coarser granularity (`<1m`, `12m`, `1h5m`)
  — anything under a minute collapses to `<1m`.

This changes the stats line to show run count, last-run recency, total run
duration, cost, and tokens; gives the active-run card second-level
granularity; makes both "somewhat live" without a client-side ticking
mechanism or client/server clock comparison; and gives every duration display
in the app the same granularity rules down to whole seconds.

## Goals

1. Board card stats line: `"{runCount} runs · last run {age} ·
   {totalDuration} total · {cost} · {tokens}"`.
2. Active-run child card: elapsed time shown with second-level granularity.
3. Both of the above stay reasonably current without a dedicated
   render/ticking loop.
4. One shared duration-granularity formatter, used everywhere a duration is
   displayed (runs table, run detail, board card), with `1s` as the lowest
   displayed value — no milliseconds, no more `<1m` floor.

## Non-goals

- No change to the runs table's or run detail page's *layout* — only the
  formatter they call changes.
- No live/ticking UI components. "Somewhat live" is satisfied by the board's
  existing 3s poll re-fetching freshly computed values from the API, not by
  the client re-rendering on its own clock.
- No change to `dwellSince`'s existing role elsewhere in the projection
  (stage-entry tracking) — only its appearance in the card stats line is
  removed.

## Why server-computed elapsed values, not client-side `Date.now()` diffing

The existing `fmtAge` pattern (diff an API timestamp against the browser
clock) has two problems this design avoids: it requires a ticking component
to stay current, and it's sensitive to client/server clock skew. Instead,
elapsed-time values (`lastRunAgeMs`, `activeRun.elapsedMs`) are computed once
on the server, at response time, using the same `now()` the board
application already threads through for projection metadata. The client
never diffs a timestamp against its own clock — it only formats a number the
API gave it. Liveness comes from the board list's existing 3-second poll
(`refreshPolicy.board`, `board.tsx:39`) re-issuing the request and getting
fresh `elapsedMs`/`lastRunAgeMs` values each time.

`totalDurationMs` (sum of completed run durations) needs no clock at all —
it's computed once, in the projection, from two already-recorded event
timestamps (`RunStarted`'s `startedAt` and the terminal event's
`occurredAt`), and persists as ordinary projection state.

## Design

### 1. Shared duration formatter (`fmtDuration`)

`src-next/surfaces/web/src/components/format.ts`'s `fmtDuration(ms: number)`
changes from minute-or-coarser to:

| Range | Format | Example |
|---|---|---|
| `< 10s` | exact seconds | `7s` |
| `10s – 59s` | nearest 10s (floor, min `10s`) | `40s` |
| `1m – 59m` | floor minutes | `12m` |
| `1h – 23h59m` | hours + minutes | `1h5m` |
| `≥ 24h` | floor days | `2d` |

No milliseconds at any range; `1s` (not `0s`) is the lowest possible
displayed value for `ms >= 1000` (values under 1000ms round up to `1s` rather
than disappearing — this only matters for near-zero test/demo data, not real
run durations).

This is the one formatter every duration display in the app uses:

- Runs table (`runs.tsx`) `Duration` column
- Run detail page (implicitly, if/when it adds a duration display — no
  current change needed there since it shows start/finish timestamps, not a
  computed duration)
- Board card stats line (`{totalDuration} total`, `last run {age}`)
- Active-run child card elapsed time

`fmtAge` (`format.ts`), which diffs a timestamp against `Date.now()`, is
removed — its one call site (`board-card.tsx`, the active-run child card)
switches to formatting the new server-provided `elapsedMs` directly via
`fmtDuration`.

### 2. New API fields

`src-next/surfaces/api/contracts/board.ts`:

```ts
export interface BoardCardActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
  readonly elapsedMs: number; // new
}

export interface BoardCardResponse {
  // ...existing fields unchanged...
  readonly totalDurationMs: number;   // new
  readonly lastRunAgeMs?: number;     // new — present iff lastRunAt is present
}
```

`startedAt` on `BoardCardActiveRun` is kept (still useful as an exact
timestamp, e.g. for a tooltip) alongside the new `elapsedMs`.

### 3. Projection change — `totalDurationMs`

`src-next/bootstrap/board-projection.ts`: `StoredCard` gains
`totalDurationMs: number`, initialised to `0` on `ItemCreated`.

`projectRun`'s terminal branch currently discards the event's `occurredAt`
parameter. It will instead compute the just-finished run's duration from the
card's own `activeRun.startedAt` (still present on `card` at that point,
before `withoutActiveRun` strips it) and accumulate:

```ts
const startedAt = card.activeRun?.startedAt;
const durationMs =
  startedAt === undefined ? 0 : Date.parse(occurredAt) - Date.parse(startedAt);
```

added into `totalDurationMs` alongside the existing `withoutActiveRun(card)`
spread, for all four terminal event types (`RunSucceeded`, `RunFailed`,
`RunCancelled`, `RunAmbiguous`).

`lastRunAt` (already present, set at `RunStarted` to the new run's
`startedAt`) is unchanged — it continues to be used for `cardRecency`
sorting, and is now also the source for `lastRunAgeMs`.

### 4. Response-time computation — `elapsedMs` / `lastRunAgeMs`

`src-next/bootstrap/surface-api-applications.ts`, `createBoardApplications`:
the `now: () => string` already passed into the factory is the single clock
used for the whole board response. In `list()`, after paging but before
`presentBoardCard`, each card is enriched:

```ts
const nowMs = Date.parse(now());
const withElapsed = (card: StoredCard) => ({
  ...card,
  ...(card.lastRunAt === undefined
    ? {}
    : { lastRunAgeMs: nowMs - Date.parse(card.lastRunAt) }),
  ...(card.activeRun === undefined
    ? {}
    : { activeRun: { ...card.activeRun, elapsedMs: nowMs - Date.parse(card.activeRun.startedAt) } }),
});
```

This keeps the projection itself clock-free (it only ever stores
timestamps and event-derived sums) and confines "what time is it right now"
to the one place that already owns a `now()` for the response.

### 5. Decoders

`src-next/surfaces/web/src/api/decoders.ts`: `decodeBoardCard` adds
`totalDurationMs: number(...)` (required) and
`...optionalNumberProperty(record, 'lastRunAgeMs', path)` (a new helper
alongside the existing `optionalStringProperty`/`optionalBooleanProperty`, or
inlined the same way). `decodeBoardCardActiveRun` adds
`elapsedMs: number(...)` (required).

### 6. Board card rendering

`src-next/surfaces/web/src/features/board/board-card.tsx`:

```tsx
<span className={styles.cardStats}>
  {`${item.runCount} runs · ${
    item.lastRunAgeMs === undefined ? 'no runs yet' : `last run ${fmtDuration(item.lastRunAgeMs)} ago`
  } · ${fmtDuration(item.totalDurationMs)} total · ${fmtCost(item.totalCostUsd)} · ${fmtCompact(item.totalTokens)} tokens`}
</span>
```

Active-run child card meta line switches from
`fmtAge(item.activeRun.startedAt)` to `fmtDuration(item.activeRun.elapsedMs)`.

## Data flow summary

```
RunStarted event ──> projection: activeRun.startedAt set, lastRunAt set
terminal event   ──> projection: totalDurationMs += (occurredAt - activeRun.startedAt)
                      activeRun cleared
board list request ──> now() captured once ──> lastRunAgeMs, activeRun.elapsedMs
                        computed from stored timestamps ──> presented ──> decoded ──> formatted
3s poll ──> repeats the above ──> displayed values advance without any client timer
```

## Testing

- `format.ts` unit tests: bucket boundaries for `fmtDuration` (9s/10s, 59s/1m,
  59m/1h, 23h59m/24h boundary cases), and the "no ms, `1s` floor" rule for
  sub-second input.
- `board-projection` tests: `totalDurationMs` accumulates across multiple
  completed runs and is unaffected by an in-flight (non-terminal) run.
- `surface-api-applications` / board E2E (`board.test.tsx`,
  `collections.test.tsx`, `app.test.tsx`, `surface-fixture.ts`): update fixed
  fixtures for the new required `totalDurationMs` field and adjust any
  snapshot/text assertions on the stats line to the new field order and
  wording; add a case asserting `elapsedMs`/`lastRunAgeMs` reflect the
  fixture's injected `now()`.
- Decoder unit tests: malformed/missing `totalDurationMs` rejected;
  `lastRunAgeMs` optional and only decoded when present.

## Out of scope / follow-ups

- Runs table and run detail page keep showing fixed start/finish timestamps
  and (for finished runs) a computed duration from those two timestamps —
  unaffected by this change beyond calling the same updated `fmtDuration`.
  An in-flight run row in the runs table still shows a blank duration
  (`runDuration` returns `''` when `finishedAt` is undefined); adding a live
  in-flight duration there is not requested and is left for a future pass if
  needed.

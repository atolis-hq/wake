# Analytics API

Analytics reports are computed on request from journal facts. No analytics
projection is added. The existing `/api/v1/observability/metrics?days=1` endpoint
continues to provide today's system counters from `operator-analytics`; its
existing `days` parameter and response are unchanged.

All routes require the same operator authentication as other API reads.

| Request | Response `data` |
| --- | --- |
| `GET /api/v1/observability/reports` | Registered report descriptors (`id`, `title`). |
| `GET /api/v1/observability/reports?window=1d&report=run-outcomes-over-time` | Selected report, window, series, totals and buckets. |
| `GET /api/v1/observability/summary?window=1d` | Window and summary metrics. |

Responses include `meta.asOf`, the query's collection time. Live queries use
journal snapshots rather than the asynchronously updated analytics projection.
Window identifiers are `1d`, `3d`, `5d`, and `7d`. Unknown report/window ids,
unknown parameters, and repeated parameters return the established HTTP 422
`invalid-query` problem with `violations`. Query requests require a window;
report requests also require a registered report id. A request with no report
query parameters returns the catalogue.

The 1d and 3d windows roll back 24 and 72 hours from request time. Buckets align
to UTC hours and UTC 6-hour boundaries respectively, including partial boundary
buckets. The 5d and 7d windows contain the preceding five or seven complete UTC
days and exclude the current day. All cohorts use `[from, to)` boundaries.
Buckets include `from`, `to`, and series-keyed `values`, including zero counts.
The window has `id`, `from`, `to`, and `bucketMs`.

Run outcomes use each run's start time (including preparation) for cohort and
bucket membership and the latest known Run view for its outcome. Activity
`done`, `blocked`, and `waiting` map to completed, blocked, and awaiting approval.
Execution failures and Activity `failed` or `rejected` map to failed. Active,
cancelled, ambiguous, and unrecognized outcomes map to other. Overall `totals`
use the same population and mapping as the buckets. Series descriptors provide
labels, so callers do not need a separate outcome label catalogue.

Summary fields are `runs`, `completed`, `blockedOrAwaitingApproval`, `failed`,
`totalTokens`, `totalCostUsd`, `medianRunDurationMs`, `workItemsDone`, and
`medianEndToEndDurationMs`. Run metrics use the start cohort. Known token fields
(input, output, cache read and cache write) and USD costs are summed; missing
usage contributes zero and partial usage contributes its available fields.
Run durations include preparation through terminal finish; active runs and
invalid/missing durations are excluded from the median. Counts and sums are
zero when empty; empty medians are `null`.

Work items done count the first completion of an associated primary workflow
per work item in the window, regardless of work creation time. Child workflow
completion does not finish a work item. End-to-end durations run from work
creation to that first completion; missing or invalid durations are excluded.

Summary and report requests are independent. Disconnecting cancels their scan;
scans read bounded batches and yield to other API and control-plane work.
Reports implement the shared `ReportDefinition` contract in their data-owning
module and are registered in Bootstrap's `analytics-reports.ts`. A report
registration supplies its descriptor and live query; the web view renders its
returned series and buckets or dimension rows.

`run-breakdowns-by-dimension` returns `report`, `window`, `total`, and
`dimensions`. Each dimension has an `id`, `title`, and `rows` containing
`value`, `count`, and `share` (a fraction of `total`), plus `tokens`,
`costUsd`, and `durationMs` totals and independent `tokenRuns`, `costRuns`, and
`durationRuns` contributing counts. Finite reported usage and valid nonnegative
finished-run durations contribute; explicit zeros count, missing values do not.
Tokens and cost reconcile to summary totals; duration uses the valid-duration
cohort (the summary reports its median). Averages divide totals by contributing
counts; zero contributors render as “n/a”. A table-wide Totals / Average per run
control defaults to Totals and switches without refetching or reordering rows. The six dimensions are
`run-action` (run activity), `run-stage`, `run-runner` (runner name), `run-model` (runner model), `run-repository`, and `run-runner-pool`
(recorded runner pool). Counts aggregate the entire selected window using the same start
cohort and latest Run facts as the summary Runs tile. Missing values appear as
`unknown`; recorded values remain distinct. Rows sort by descending count,
then alphabetically by value. Empty windows return zero total and empty rows.
Repository identity follows the run’s workflow instance to its work item and active
resource correlations. Repository resources use their canonical external key; GitHub
Issue and PullRequest resources use the typed owner/repository component of their
external key, including existing intake facts. Candidates are selected in Repository,
PullRequest, Issue order, then by ascending resource ID within a kind. A missing
correlation or an invalid selected key yields `unknown`; each run counts once.
No analytics projection or additional persisted run data is required.
The Reports tab offers a dimension selector and displays count and percentage
share, with asynchronous loading, retry on failure, and an empty state.

`token-and-cost-usage` returns a time series with `total-tokens` and
`total-cost-usd` measures, labelled with `tokens` and `USD` units.
It uses the same run start cohort, usage parser, and window buckets as the
summary tiles. Missing usage contributes zero; partial usage contributes its
available counters and reported cost. Empty windows return zero totals and
zero-valued buckets. No token category splits or dimensional groupings are
included. The web view plots each measure separately because their units differ.

`work-item-throughput` returns completion series and buckets with the
`work-items-done` measure (unit `work items`), reconciling with the Work items
done tile. Cohort membership uses the first primary workflow completion in
journal order, with the same half-open window and UTC bucket boundaries.
Duplicate and child completions do not count. It also returns `durationRows`,
ordered by completion time descending, then work ID for ties. Rows contain
`id`, `title` (the recorded creation objective), `createdAt`, `completedAt`, and
`durationMs`. Missing or invalid creation times and completion before creation
exclude duration rows only; `excludedDurationCount` states how many qualifying
completions have no valid duration. Invalid completion times cannot belong to
a window. Empty windows return zero totals, zero buckets and no duration rows.
The Reports view explains exclusions and retains counts when all durations are
excluded, with independent asynchronous loading, error/retry and empty states.
Malformed persisted events (including non-ISO timestamps) are rejected by the
owning event decoder and use the report error state rather than being silently
ignored. Duration exclusions apply to decoded facts with missing creation or
inconsistent time ordering.

The `run-duration` report shows run duration by Action and Stage and over the
selected window's buckets, using run start time for cohort and bucket membership.
Median is primary and arithmetic average is secondary, both in milliseconds in
the API and seconds in the UI, alongside qualifying-run counts. Unfinished runs
and runs without valid, nonnegative start/finish durations are excluded; zero
durations qualify. Missing dimensions use `unknown`. Empty statistics are null
("No data" in the UI), and empty buckets remain present. The overall median
matches the summary tile. Reports load asynchronously with loading, retry and
empty states, using live facts without an additional projection. The duration
response has `statistics`, `groups` (descriptors with value/statistics rows),
and `buckets` (from/to plus statistics); statistics contain `count`,
`medianMs`, and `averageMs`.

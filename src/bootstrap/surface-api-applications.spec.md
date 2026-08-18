# API surface application — Component Specification

## Type, purpose, and scope

Surface application. The API surface application translates the composed
application graph's state into the system, control-plane, resources,
orchestration, execution, events, and observability responses the HTTP API
(and the CLI commands that host it) expose. Work's list and detail responses
are a distinct component; see
[Work detail and list surface application](surface-api-work-applications.spec.md).

## Ubiquitous language

- **Freshness metadata** — the `asOf`/`position` pair attached to every
  response, stating the journal instant and global position the returned
  data is guaranteed current as of.
- **Cursor position** — a caller-supplied journal global position; a
  collection response only returns items whose contributing facts are
  strictly before it (unbounded, i.e. the newest facts first, when absent),
  walking backward through history one page at a time.

## Responsibilities and boundaries

This component owns read composition over the graph's projections and the
journal, and the two state-changing operations exposed at this level:
advancing the control plane by one step, and pausing/unpausing a runner. It
does not own how a projection is computed (each module owns its own), does
not own the redaction rule applied to configuration before it is returned
(Surfaces owns that presenter), and does not own cross-module aggregation
for a single WorkItem (see the Work detail component).

## Core policies, invariants, and behaviours

**Freshness and pagination (shared by every list/detail response below)**

- A collection response MUST only include items whose contributing
  projection's last recorded global position is strictly before the
  caller's cursor position, ordered descending by that position — newest
  first. `events.list` applies the same before/descending rule directly to
  raw journal global positions rather than to a projection's recorded
  position.
- A collection response's `total` MUST report the full filtered-eligible
  count, not just the returned page; a `nextPosition` MUST be present only
  when further (older) items remain beyond the returned page, carrying the
  page's oldest visible item's own position so the next call continues
  further back in time.
- A response's freshness metadata MUST be derived from the highest
  contributing global position among the items or projections that produced
  it, resolved back to that position's actual journal fact. If a computed
  position does not correspond to a real stored fact, producing freshness
  metadata MUST fail rather than return a fabricated timestamp.
- An empty collection with no caller-supplied cursor MUST report freshness
  as of the call's own current time, since there is no contributing fact to
  derive it from.

**System**

- `health` MUST report a fixed, unconditional `ok` status for the journal,
  projections, and checkpoints checks; it does not itself read any of those
  stores to confirm they are reachable — it is an optimistic signal, not an
  active probe. (Contrast the CLI surface application's `validate-state`
  health command, which does actively probe each store.)
- `health` MUST additionally report a `self-update` check that is `ok` when
  no self-update failure is on record and `degraded`, with the rolled-back
  tag/time/message as its detail, when one is — this check does actively
  read the self-update failure log rather than reporting optimistically.
  The response's overall `status` MUST be `degraded` when any check is
  degraded, `ok` otherwise, and MUST include this installation's resolved
  version string.
- `configuration` MUST return the composed root configuration with any key
  whose name looks secret-shaped redacted before it is returned; this
  component supplies the full configuration value, and Surfaces' own
  presenter decides what is redacted.
- `commands` MUST return one entry per composed provider instance that
  exposes a `commands()` accessor, carrying that instance's adapter id,
  provider id, and its reported command list verbatim; a provider instance
  with no `commands()` accessor MUST be omitted rather than reported with an
  empty list.

**Board and status**

- `board.list` MUST order cards by recency — a card's most recent run start
  time, falling back to when it entered its current stage — newest first,
  and MUST paginate by page offset rather than by the shared global-position
  cursor convention used elsewhere in this component.
  Each card MUST be enriched at read time with: its primary correlated
  resource's resolved external reference, when one exists; an elapsed-time
  duration for each active run and for how long ago its last run started,
  computed against the call's own current time rather than stored on the
  projection. `conditionCounts` MUST be computed from the same underlying
  board projection as the returned page, not from the page's own contents.
- `status.get` MUST report the same `conditionCounts` the board itself
  reports, with no additional fields.

**Control plane**

- `pause`/`resume` MUST delegate to the composed control-plane service
  keyed by the caller's idempotency key and MUST report accepted once the
  command has been durably recorded, mirroring `pauseRunner`/`unpauseRunner`'s
  own idempotency contract below.
- `status` MUST report whether dispatch is currently paused, from the
  control-plane projection; `pausedUntil`/`reason` MUST be present only
  when a pause is currently recorded. A control plane that has never
  recorded a pause MUST report as not paused, using the call's current time
  as freshness — this is a valid, meaningful state, not an error.
- `advance` MUST be idempotent per caller-supplied idempotency key, bounded
  to this process's own lifetime and to a bounded recent-history window: a
  key whose result is still remembered MUST return that exact prior result
  without advancing again; a key currently in flight MUST return the same
  in-flight result to every concurrent caller rather than advancing twice.
  This memoization is a concurrency safeguard for this process only, not a
  durable command-idempotency guarantee — a caller that retries after a
  process restart, or once the key has aged out of the remembered window,
  MUST NOT expect the prior result back.
- One `advance` call MUST run a full pass of the same composed runner
  pipeline the CLI `tick` command and the resident runner loop run —
  schedules, reactors, one bounded unit of control-plane progress, and one
  outbound delivery attempt, each surrounded by a projection catch-up — not
  merely an isolated advance step; `advance` is this component's only entry
  point into that pipeline, so its returned status always reflects the same
  work a tick would have done.

**Resources and orchestration**

- Resources' `list` MUST expose every currently known resource; a
  tombstoned (nulled) resource entry MUST be excluded rather than presented
  as an empty row. Each presented resource MUST carry an `externalUrl` when
  the composed link resolver can produce one for that resource's adapter/key
  pair, and MUST omit it otherwise rather than presenting a broken link.
- Orchestration's `list` MUST support an optional `state` filter and MUST
  exclude any workflow instance whose projection has no current view.

**Execution**

- `pauseRunner`/`unpauseRunner` MUST delegate to the runner control
  command surface, keyed by the caller's idempotency key, and MUST be
  reported completed once that command has been durably recorded — this
  idempotency is control-plane's own durable per-key dedup, not this
  component's in-process memoization.
- `list` MUST support an optional `state` filter; `get` MUST report absent
  for a run id with no recorded view rather than an error. Both MUST enrich
  a present run with its owning workflow instance's `workflowName` when
  that instance is still known, while preserving the run's durable
  originating `stage`; it MUST NOT derive a historic stage from current
  workflow state, and MUST leave the run unenriched when the instance is
  not known (e.g. it has since been superseded away).
- `runners` MUST synthesize availability purely from the configured runner
  pools crossed with the currently ineligible runner set computed from the
  control-plane projection at call time. A runner absent from every
  configured pool MUST NOT appear in this listing even if it is configured
  as a runner.

**Events and observability**

- `events.list` MUST page over the raw journal by global position, using
  the same cursor/freshness semantics as every other collection here.
- `observability.metrics` MUST report current totals (event count, work
  item count, run count) computed from the full journal and projection
  state at call time; it is a point-in-time snapshot, not a windowed or
  historical series.

## Dependencies and system role

- Every composed module service (Work, Resources, Orchestration, Execution,
  Control-plane) — this component only reads their projections and calls
  their own command surfaces; it never folds events itself.
- Persistence's projection store and event journal — read directly for
  freshness metadata and for the raw events feed.
- Surfaces (depends on this component) — defines the response shapes this
  component produces values for, and owns the configuration-redaction and
  pagination-cursor presentation rules this component's output is passed
  through.

## Decisions, exclusions, and deferred capability

- `observability.metrics` accepts no time-window parameter at this
  composition; whatever window a caller requests, the response is always
  computed over the entire journal.
- Work's `retry` command is not composed at this layer — this component
  wires only the read/command surfaces described above; a capability not
  wired here is simply absent from this composition, not rejected at
  request time.
- `advance`'s in-process idempotency memoization is bounded to the most
  recently seen 100 keys; older keys are evicted and a repeated call with
  an evicted key advances again rather than replaying the old result.

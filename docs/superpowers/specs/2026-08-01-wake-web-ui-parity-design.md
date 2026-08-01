# Wake web UI parity and restyle design

Date: 2026-08-01
Status: approved
Branch: `rewrite/wake-web-ui-parity`
Authority: [`2026-07-30-wake-web-surface-architecture-design.md`](2026-07-30-wake-web-surface-architecture-design.md)

## 1. Executive decision

The `src-next` web surface is architecturally correct and visually bare. This
work restyles it to the legacy control-plane look and closes the presentation
gaps that today's `/api/v1` can already support, without changing the API,
domains, or bootstrap composition.

Every content gap that requires a server change is recorded in the gap register
in §8 rather than being worked around in the browser. The register is a
deliverable of this design in its own right.

Three decisions govern the work:

1. **Dark theme only, on a two-layer token system.** Components reference
   semantic tokens exclusively, so a light theme later is one assignment block
   and zero component edits.
2. **UI-only scope.** No file under `src-next/surfaces/api/`,
   `src-next/bootstrap/`, or any domain module is modified.
3. **No control that cannot work.** A button whose route returns 501 is not
   shipped disabled or hopeful; it is not shipped.

## 2. Context and evidence base

The legacy UI is three files under `src/adapters/http/`: `ui-assets.ts` (1191
lines, a single HTML template string with inline CSS and imperative DOM code),
`ui-data.ts` (1457 lines, the read models), and `ui-server.ts` (603 lines).

The target UI is 26 files and 2206 lines under `src-next/surfaces/web/src/`,
using React Router, TanStack Query, CSS Modules, and typed response decoders.

This design was written against both source trees and against a live legacy
instance. Where the two disagree, source is authoritative — two legacy views
(Analytics and Health) never rendered on the live instance and were read from
source instead. §8 records why they hang.

### 2.1 What the target already does better

These are not regressions to fix and must survive the restyle:

- cursor pagination with typed decoders, against legacy's unpaginated
  `getJson('/runs')`;
- independent per-component refresh, against legacy's 7-second
  `switchView(currentView)` full re-render;
- the events feed's pause / buffered-count / resume with a bounded 200-record
  merge (`features/events/events.tsx:146`), which legacy has no equivalent of;
- route-backed modals — a work item detail is a real shareable URL, where
  legacy modal state is unaddressable;
- an `AbortSignal` on every query, against legacy's single
  `activeViewRequest` global.

### 2.2 What legacy does better

Density, colour semantics, and information per screen. The legacy board card
communicates condition, workflow, stage, dwell time, labels, run count, cost,
and token spend in about 120px of height. The target card shows
`workItemId · state`.

## 3. Goals and non-goals

### 3.1 Goals

- Port the legacy visual language — dark surfaces, teal brand, condition colour
  vocabulary, dense chips and pills — onto the target component layer.
- Bring each target route to the content parity today's API permits.
- Replace the target's two raw `JsonViewer` dumps that stand in for real
  presentation (work detail, run transcript) with domain presentation.
- Record every remaining gap with file-level evidence and a disposition.

### 3.2 Non-goals

- **Authentication.** The legacy server accepts a `Bearer` token or a
  `wake_ui_token` cookie (`ui-server.ts:59-67`). The target surface is
  deliberately unauthenticated and locally scoped, per the web surface
  architecture design §1. Not ported, not registered as a gap.
- **API, domain, or bootstrap changes.** Deferred to the tasks named in §8.
- **Integration- or activity-specific presentation.** The browser renders
  resources as generic references only (§6.3.1). No pull-request, issue, repo,
  or other kind-aware component ships, and no code branches on a resource kind
  or provider.
- **Charts.** No graph framework is installed, per the web surface design §8.1,
  and the metrics contract currently exposes three scalars.
- **Drag and drop.** Prohibited by the web surface design §7.2 — a visual move
  must not imply a workflow command the domain has not defined.

### 3.3 API shape: no BFF

Where a screen needs data joined or reshaped, the fix goes on the existing
domain resource — never into a UI-specific endpoint. The web surface
architecture design §1 already commits to "one UI-agnostic `/api/v1`"; this
section records why that holds up under the pressure this work applies to it,
and what to do instead.

`/api/v1` has more than one consumer. `src-next/surfaces/cli` reads the same
applications, and the HTTP surface is Wake's integration point. An endpoint
shaped for one board layout couples the server to a presentation decision that
changes far more often than the domain does.

The distinguishing test is: **does the response shape encode a fact, or a
layout?**

- Denormalizing `currentStage` onto `WorkItemResponse` encodes a fact. Every
  consumer benefits, one collection stays authoritative, pagination stays
  coherent. This is the preferred fix and covers GAP-02.
- A derived read model such as the condition vocabulary also encodes a fact, and
  belongs on the resource that owns it — which is why GAP-01's home is a
  presenter on the work resource, not a `/board` endpoint.
- An endpoint returning six named columns encodes a layout. That is precisely
  the legacy mistake: `deriveCondition` lives inside an HTTP adapter
  (`ui-data.ts:53-101`), so the vocabulary is trapped there, invisible to the
  CLI and untestable apart from the transport.

A genuine aggregate endpoint is justified only when a screen needs data from
three or more collections with no single owning resource, and no denormalization
would be honest. No surface in §6 meets that bar.

Client-side joining is therefore a stopgap, permitted only while UI-only scope
holds, and only where the resulting inaccuracy is stated. §6.1 is the one such
case and states it.

## 4. Token architecture

`styles/tokens.css` is currently 18 declarations of light-theme values. It is
replaced by two layers in the same file.

**Layer 1 — palette.** Raw values, referenced only by layer 2.

**Layer 2 — semantic.** The only names any component may reference:

| Group | Tokens |
| --- | --- |
| Surface | `--surface`, `--surface-panel`, `--surface-card`, `--surface-inset` |
| Line | `--border`, `--border-strong` |
| Text | `--ink`, `--ink-muted`, `--ink-inverse` |
| Brand | `--brand`, `--brand-dark`, `--brand-darker` |
| Accent | `--accent`, `--accent-light` |
| Condition | `--cond-{ready,scheduled,active,needs-human,error,finished}-{fg,bg}` |
| Status | `--good`, `--warning`, `--bad` |
| Form | `--space-*`, `--radius`, `--shadow`, `--focus-ring` |
| Type | `--font-sans`, `--font-mono`, `--text-{xs,sm,base,lg}` |
| Layout | `--content-width`, `--breakpoint-narrow`, `--motion-fast` |

Dark values come from the legacy palette: `--surface: #14161a`,
`--surface-panel: #1a1d23`, `--surface-card: #22262e`, `--border: #2c313a`,
`--ink: #e8e8e8`, `--ink-muted: #9aa2ad`, `--brand: #0f766e`,
`--brand-dark: #134e4a`, `--brand-darker: #103a37`, `--accent: #2dd4bf`,
`--accent-light: #5eead4`, and the six condition pairs from
`ui-assets.ts:53-58`.

Adding a light theme later means adding one `:root[data-theme='light']` block
assigning layer 2 from layer 1. No component changes. That is the entire reason
for the two-layer split.

This also absorbs three hardcoded colours currently outside the token file:
the `#f2a900` focus ring in `global.css:24`, and `#ffd28a` / `#e7eef8` in
`components.module.css:157,162`.

Typography, motion duration, content width, and breakpoint tokens are added
because the web surface design §8.3 requires them and the current file omits
them.

## 5. Shell

Legacy uses three horizontal bands with decreasing lightness — brand topbar
(`--brand`), status bar (`--brand-dark`), navigation (`--brand-darker`) with an
accent underline on the active tab. The target has a two-band ink/white shell.

The three-band structure is ported onto the existing `AppShell`. `NavLink` and
`aria-current='page'` are retained; only the styling changes. `ControlPlaneStatus`
moves into the status band.

The legacy status bar's counters (runs today, failures today, cost today, source
freshness, last run) are **not** ported — see GAP-12.

## 6. Per-surface plan

### 6.1 Board

Legacy groups into six derived conditions. The target groups into three
`WorkItemResponse.state` values because the list endpoint carries nothing else
(`contracts/work.ts:8-17`).

**Mechanism, under protest.** The board additionally fetches
`/api/v1/workflow-instances` — a real cursor-paginated collection route
(`routes/read.ts:18`) — and joins client-side on
`WorkflowInstanceResponse.workItemKey` (`contracts/orchestration.ts:3`). One
extra request, no N+1, and it yields `currentStage`, `status`, and `waitingFor`
per work item.

This is a workaround forced by the UI-only scope, not the right shape, and it
has a real defect: the two collections paginate independently, so their cursors
do not align. A work item on the current `/work-items` page whose workflow
instance falls outside the current `/workflow-instances` page renders without a
stage chip. That is tolerable at present volumes and wrong in principle.

The correct fix is GAP-02 — denormalize stage and workflow status onto
`WorkItemResponse` — which removes the second request, the join, and the cursor
misalignment together. Per §3.3 that is a presenter change on an existing
resource, not a new UI endpoint. The client-side join should be deleted the day
GAP-02 lands.

**Columns** remain `state`-derived until GAP-01 lands. Stage, workflow status,
and waiting-signal become card chips now.

**Card** adopts the legacy treatment: title, status pill, meta chips, stats
line, and a condition-coloured left border. Column headers gain counts.
Collapsible columns with `localStorage` persistence are ported from
`ui-assets.ts:293-320` — the target has no equivalent and the web surface design
§7.2 requires them on mobile.

The duplicated workflow chip in `renderCardSummaryNodes` (workflow appears both
as `chip-meta` and again in the label list) is not reproduced.

### 6.2 Work list

`DataTable` is already sound. It gains stage and workflow-status columns from
the §6.1 join, localized timestamps via the existing `LocalTime` component, and
styled filter controls. Search and state filters already function.

### 6.3 Work detail

This is the target's weakest surface: a five-row `<dl>` followed by
`JsonViewer(activities)` (`features/work/work.tsx:134-148`). It is replaced with
labelled sections:

- **Summary** — objective, work item key, state, current stage, workflow name.
- **Resources** — a generic reference list, described in §6.3.1.
- **Runs** — a table linking each row to `/runs/:runId`, with localized start
  time, computed duration, status badge, and runner once GAP-05 lands.

`JsonViewer` is retained only where the raw structure is itself the evidence, per
the web surface design §7.3.

#### 6.3.1 Resources are a generic reference

The browser treats a resource as an opaque reference and renders only the
provider-neutral vocabulary the resource contract already exposes:
`resourceId`, `kind`, `capabilities`, and `revision`
(`contracts/resources.ts:1-6`).

Presentation is driven by `kind` and `capabilities` as open values — a chip per
capability, the kind as a label, the identifier as text. The browser must not
branch on a specific kind, infer a provider, or parse a resource identifier.
This is the client-side counterpart of the rule in ADR-0001 that core compares
resource URIs for equality and never parses a locator.

No integration- or activity-specific panel ships. In particular
`WorkDetailResponse.activities.pullRequest` (`contracts/work.ts:27,30-36`) is
**not** given bespoke presentation, even though the data is already there and a
panel would be easy. Pull requests are a first-class Activities domain in
`src-next/activities/pr/` and the view is provider-neutral, so this is not a
GitHub leak — but "pull request" is still a concept only some integrations have,
and a dedicated panel would put activity-kind knowledge in the shell. Deferred
to §7 pending a generic activity-presentation contract.

The consequence is honest rather than convenient: until that contract exists,
activity-specific state such as PR checks or review status is simply not shown.

Legacy's `context` blob (`ui-assets.ts:732-733`) has no target equivalent and is
deliberately not reproduced — it is a projection internal, not operator
information.

### 6.4 Events

The events page adopts the legacy modal's event-card design
(`ui-assets.ts:113-126`): monospace timestamp, event type, truncated id. The
existing pause / buffer / resume behaviour is retained unchanged.

Direction arrows and expand-to-JSON require GAP-06. A per-work-item events tab —
which legacy has and the target lacks entirely — requires GAP-07.

### 6.5 Runs

List and detail are styled. `RunDetail` currently renders the transcript through
`JsonViewer`; it is replaced by structured entries, since
`RunTranscriptResponse.entries` is already typed as
`{occurredAt, channel, text}` (`contracts/execution.ts:19-23`). Legacy's
undifferentiated transcript wall is not reproduced.

### 6.6 Health, Observability, Configuration

Health keeps its badge grid and runner table and is restyled. Observability
renders its three scalars as legacy-style tiles (`ui-assets.ts:143-146`).
Configuration keeps `JsonViewer` with a dark-token `pre`.

None of legacy's `<pre>` dumps for storage, sources, or integrity issues are
ported.

## 7. Deferred

| Item | Reason |
| --- | --- |
| Analytics and charts | No chart framework (web surface design §8.1); metrics contract exposes three scalars (GAP-13) |
| Light theme | Token layer makes it cheap later; no current demand |
| Drag and drop | Prohibited by web surface design §7.2 |
| Pull request panel, and any kind-aware resource presentation | §6.3.1 — needs a generic activity-presentation contract (GAP-16) |
| Event payload viewer, direction filter | GAP-06 |
| Per-work-item events tab | GAP-07 |
| Freeze, unfreeze, delete, retry, pause, resume controls | GAP-10, GAP-11 — routes return 501 |
| Status bar counters | GAP-12 |
| Routing table view | GAP-14 |

## 8. API gap register

Disposition values: **cheap-now** (unblocked, small, but out of this UI-only
scope), **25A.x** / **25B** (an in-flight rewrite packet already covers the
underlying fact), **new** (needs a decision and a task of its own).

| ID | Gap | Disposition |
| --- | --- | --- |
| GAP-01 | Board condition vocabulary | Mostly derivable; blocked on GAP-11 and 25A.7 |
| GAP-02 | Stage and workflow on the work list | cheap-now (worked around) |
| GAP-03 | Tags and labels | 25A.7 |
| GAP-04 | Token and cost figures | cheap-now |
| GAP-05 | Runner and model on `RunResponse` | cheap-now |
| GAP-06 | Event direction and payload | new |
| GAP-07 | Events filtered by work item | new |
| GAP-08 | Real health checks | new (correctness) |
| GAP-09 | Runner availability | 25B |
| GAP-10 | Control-plane pause and resume | 25A.8 |
| GAP-11 | Work commands: freeze, unfreeze, delete, retry | new |
| GAP-12 | Status bar counters | Blocked on GAP-04 |
| GAP-13 | Observability windows and metrics | new (correctness) |
| GAP-14 | Routing table | new |
| GAP-15 | Resource browse URL | new |
| GAP-16 | Generic activity presentation contract | new |

### GAP-01 — Board condition vocabulary

Legacy derives six conditions in `deriveCondition` (`ui-data.ts:53-101`), which
its own comment documents as a display-only read model that "never decides
anything the tick doesn't independently decide".

This is **not a new domain fact**. It is a derivation over inputs that largely
exist in the target already: run status (`RunView.status`), workflow stage and
status (`WorkflowInstanceResponse`), and terminal-stage knowledge from the
compiled workflow. Two inputs are missing — the frozen flag (GAP-11) and the
scheduled-workflow marker, which legacy reads from a label and which 25A.7
replaces with WorkItem tags.

Correct home: an API presenter, once its two inputs exist. Not a domain change.

### GAP-02 — Stage and workflow on the work list

`WorkItemResponse` carries `workItemKey`, `workItemId`, `objective`, `state`,
and `relatedWorkItems` (`contracts/work.ts:8-17`). Stage lives on
`WorkflowInstanceResponse` and reaches the browser only through the detail
route.

Worked around in §6.1 by joining `/workflow-instances` client-side, with the
cursor-misalignment defect recorded there.

The fix is a presenter that denormalizes `currentStage` and workflow status onto
`WorkItemResponse`. Per §3.3 this encodes a fact rather than a layout, so it
serves the CLI as well, keeps one paginated collection authoritative, and lets
the client-side join be deleted. This is the highest-value entry in the register
relative to its cost.

### GAP-03 — Tags and labels

No tag or label field exists on any work contract. Task 25A.7 adds WorkItem
tags — `test-next/work/tags.test.ts` asserts "projects tags onto the WorkItem
view". Once that lands, the API contract and presenter still need to surface
them; the browser work is then trivial.

### GAP-04 — Token and cost figures

**The fact is already in the journal.** `runnerResultPayloadSchema` carries
`tokenUsage {input, output, cacheRead, cacheWrite, costUsd}`
(`execution/contracts/event-schema-components.ts:41-67`). `foldRun`
(`execution/domain/run.ts`) does not retain it, so it never reaches `RunView`
(`execution/contracts/views.ts:24-44`) or `RunResponse`
(`surfaces/api/contracts/execution.ts:1-14`).

Fix is fold plus view plus presenter. No new event, no migration, no domain
decision. This unblocks GAP-12 and the board's cost and token stats.

### GAP-05 — Runner and model on `RunResponse`

`foldRun` already retains `runner: {name, model}` (`execution/domain/run.ts:16`)
and `RunView` already declares it (`contracts/views.ts:33`). `RunResponse` simply
omits it. A presenter-only change and the cheapest item in this register.

### GAP-06 — Event direction and payload

`AuditEventResponse` exposes `id`, `type`, `occurredAt`, `position`, `stream`,
`causationId`, `correlationId` (`contracts/events.ts:1-9`). Legacy shows an
inbound/outbound/internal direction arrow and expands each row to its full JSON
payload.

Direction is a genuine modelling question — legacy derived it from an adapter
concept the target does not share. Payload exposure needs a redaction decision
before it can ship.

### GAP-07 — Events filtered by work item

`/api/v1/events` accepts only `cursor` and `limit` (`routes/read.ts:21`). The
legacy work item modal has an Events tab; the target has no per-item event view
at all. Needs a filter parameter and a supporting index.

### GAP-08 — Real health checks

`system.health` returns a hardcoded `status: 'ok'` with three checks that are
always `ok` (`bootstrap/surface-api-applications.ts:121-137`). The endpoint
cannot currently report a degraded system, which makes the Health route
decorative.

Legacy's health is the opposite failure: `buildHealth` recursively `stat`s every
file under `events/`, `state/`, `runs/`, and `workspaces/`
(`ui-data.ts:1378-1382`), which is why it did not render on the live instance.
Neither design should be adopted. Real checks should be bounded and cheap.

### GAP-09 — Runner availability

`execution.runners` synthesises entries from `config.execution.tiers` with
`status: 'available', available: true` hardcoded
(`bootstrap/surface-api-applications.ts:256-274`). No quota, pause, or failure
state exists.

Legacy tracks per-runner `pausedUntil`, `failureCount`, and `lastFailureAt` in a
ledger and renders an inline Unpause control in its routing table
(`ui-data.ts:1315-1320`, `ui-assets.ts:1074-1093`). Task 25B (runner fidelity)
is the natural home.

### GAP-10 — Control-plane pause and resume

`routes/commands.ts:68-73` routes `pause`, `resume`, and `advance`, but
`createControlPlaneApplications` exposes only `status` and `advance`
(`bootstrap/surface-api-applications.ts:148-174`), so pause and resume return
501.

Task 25A.8 adds the pause gate, including `ControlEventType.DispatchPaused` and
a test asserting it "pauses on operator request and on quota with the same event
and a distinct reason". Wiring the application behind the existing route should
follow it directly.

### GAP-11 — Work commands

`routes/commands.ts:41` routes `freeze`, `unfreeze`, `delete`, and `retry`, but
`createSurfaceWorkApplications` exposes only `list` and `detail`
(`bootstrap/surface-api-work-applications.ts:17-42`), so all four return 501.

Freeze in particular also blocks GAP-01, since legacy's first condition branch is
the frozen check.

### GAP-12 — Status bar counters

Legacy computes runs today, failures today, cost today, source freshness, and
last run in `buildStatus` (`ui-data.ts:240-357`). Cost depends on GAP-04.
Freshness depends on source poll state that the target does not yet expose.
`loopState` derives from two lock files plus the pause flag
(`ui-data.ts:270-276`); the target equivalent would derive from run leases and
control-plane state.

### GAP-13 — Observability windows and metrics

`MetricsResponse` is `{collectedAt, values: Record<string, number>}`
(`contracts/observability.ts:1-4`) carrying three counts. Legacy offers four
windows and seventeen metrics (`ui-data.ts:601-619`) over a summary of ten
aggregates (`ui-data.ts:621-632`).

The target implementation also calls `journal.readAll(0)` on every request
(`bootstrap/surface-api-applications.ts:101`) — a full journal scan behind a
polling UI, the same class of problem that made legacy Analytics unusable. This
should be fixed before the metrics surface grows, not after.

### GAP-14 — Routing table

No endpoint exposes stage, action, tier, runner, model, and fallback order.
Legacy builds it from config in `buildConfigView` (`ui-data.ts:1306-1333`).
Depends on GAP-09 for the per-candidate pause state that makes it useful.

### GAP-15 — Resource browse URL

`ResourceItemResponse` is `{resourceId, kind, capabilities, revision}`
(`contracts/resources.ts:1-6`). Legacy built `github.com` URLs by parsing the
resource URI in the browser (`ui-assets.ts:463-476`).

That approach is not available to the target: ADR-0001 establishes that core
compares resource URIs for equality and never parses a locator, and §6.3.1
extends the same rule to the browser. The browsable URL must therefore be
emitted by the provider adapter as an opaque field on the resource, which the
browser renders without interpreting.

### GAP-16 — Generic activity presentation contract

`WorkDetailResponse.activities` is currently a single optional
`pullRequest` field (`contracts/work.ts:27`). Presenting it means the browser
knows about one activity kind, which §6.3.1 forbids.

What is missing is a provider- and kind-neutral way for an Activity to describe
its own operator-facing state — something the browser can render generically
(labelled fields, status values, capability chips) without a component per
activity kind, and without the shell growing a branch each time an Activity is
added.

Until that exists, activity state is not shown at all. This is the deliberate
cost of the rule, recorded so the omission is not mistaken for an oversight.
Designing that contract is a task of its own and should not be improvised inside
a restyle.

## 9. Testing

Existing behaviour tests under `src-next/surfaces/web/test` and the Playwright
journey in `src-next/surfaces/web/e2e/operator-journey.spec.ts` must keep
passing; the restyle changes presentation, not routes or query behaviour.

New coverage:

- the board's `/workflow-instances` join renders stage chips and tolerates a
  work item with no workflow instance;
- collapsible board columns persist across reload and are keyboard operable;
- work detail renders resources generically from `kind` and `capabilities`,
  including a kind the test invents, proving no component branches on a known
  kind;
- work detail renders no activity-specific section even when
  `activities.pullRequest` is present in the response;
- run detail renders transcript entries structurally and shows the unavailable
  state when `available` is false;
- contrast: every semantic token pair meets WCAG AA, asserted over the token
  file rather than by eye.

The gate is `npm run verify:next`, plus `npm run lint:contracts`,
`npm run lint:architecture`, and `npm run knip:next` per `CLAUDE.md`.

## 10. Sequencing

1. Token layer and shell (§4, §5) — every later step depends on the tokens.
2. Shared components: `StatusBadge` condition tones, chips, pills, tiles.
3. Board (§6.1), including the join and collapsible columns.
4. Work list and work detail (§6.2, §6.3).
5. Events, runs, health, observability, configuration (§6.4-§6.6).
6. Contrast and accessibility pass.

Steps 3 through 5 are independent of one another once step 2 lands.

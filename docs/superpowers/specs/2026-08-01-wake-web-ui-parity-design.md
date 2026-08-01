# Wake web UI parity and restyle design

Date: 2026-08-01
Status: approved
Branch: `rewrite/wake-web-ui-parity`
Authority: [`2026-07-30-wake-web-surface-architecture-design.md`](2026-07-30-wake-web-surface-architecture-design.md)

## 1. Executive decision

The `src-next` web surface is architecturally correct and visually bare. This
work restyles it to the legacy control-plane look, and introduces the operator
read models the control-plane UI needs — starting with the board — as first-class
APIs separate from the domain.

Every remaining content gap is recorded in the gap register in §8 rather than
being worked around in the browser. The register is a deliverable of this design
in its own right.

Four decisions govern the work:

1. **Dark theme only, on a two-layer token system.** Components reference
   semantic tokens exclusively, so a light theme later is one assignment block
   and zero component edits.
2. **Operator read models are in scope; domain changes are not.** Phase A is
   UI-only. Phase B adds operator capabilities (§3.3) as new projections,
   applications, presenters, and routes. No domain module gains a field, a
   method, or a behaviour because a screen wants it.
3. **The browser stays generic.** Resources are opaque references; no component
   branches on a resource kind, provider, or activity type (§6.3.1).
4. **No control that cannot work.** A button whose route returns 501 is not
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
- **Domain changes.** No work, orchestration, execution, resources, or
  activities module is modified. Operator read models consume those domains;
  they do not alter them. Gaps needing a domain fact stay in §8 and belong to
  the rewrite packets named there.
- **Integration- or activity-specific presentation.** The browser renders
  resources as generic references only (§6.3.1). No pull-request, issue, repo,
  or other kind-aware component ships, and no code branches on a resource kind
  or provider.
- **Charts.** No graph framework is installed, per the web surface design §8.1,
  and the metrics contract currently exposes three scalars.
- **Drag and drop.** Prohibited by the web surface design §7.2 — a visual move
  must not imply a workflow command the domain has not defined.

### 3.3 API shape: operator read models, not denormalized domains

Three shapes were considered for data a screen needs joined or derived. Two are
rejected.

**Rejected — denormalize onto the domain resource.** Adding `currentStage` to
`WorkItemResponse` because the board wants it makes a domain-shaped contract
inherit a field for a presentation reason. The next screen adds another. Domain
resources describe their domain; they do not accumulate columns on behalf of
callers.

**Rejected — join in the browser.** Client-side joining breaks as soon as either
side is paginated or filtered: the cursors are independent, so a row on one page
can reference an entity outside the other's page. Fixing that generically means
every collection endpoint grows set-selection (`?ids=`) purely to serve clients
that are stitching — which contaminates every domain API instead of one. That is
a worse outcome than the problem it avoids.

**Adopted — operator capabilities are their own read models.** "What needs my
attention" (board) and "what is this costing" (analytics) are operator
questions, not renderings of a domain aggregate. Each gets its own projection,
application, and resource, composed in the production root like any other
projection, and sits alongside the domain-shaped resources rather than inside
them.

These remain UI-agnostic in the sense that matters: they return operator facts —
condition, dwell time, counts, spend — not columns, colours, or ordering. The
test is whether a CLI would want the same endpoint. For board and analytics it
plainly would (`wake board` is a reasonable command); for anything describing
layout it would not. Presentation stays in the browser.

This is not a BFF. A BFF is a per-client transport that mirrors one UI's screens.
An operator read model is a genuine capability with a single definition,
consumable by the web UI, the CLI, and any future client alike.

Legacy got the capability right and the placement wrong. `deriveCondition` is a
legitimate read model, but it lives inside an HTTP adapter
(`ui-data.ts:53-101`), so it cannot be tested apart from the transport and the
CLI cannot reach it. The correction is to move that derivation into a composed,
rebuildable projection — not to abolish the board endpoint.

Where these read models should live as modules — a dedicated operator area
versus extending an existing one — is deliberately left open here; it is a
question for the task that builds them, not for a restyle.

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

**No client-side join.** An earlier draft of this design had the board fetch
`/api/v1/workflow-instances` and join on `workItemKey` to recover stage. That is
withdrawn under §3.3: the two collections paginate independently, so the join is
wrong whenever either side pages or filters, and making it correct would require
set-selection on every collection endpoint.

**Phase A — restyled, not enriched.** The board groups by
`WorkItemResponse.state` and shows only what that response carries. No stage
chip, no dwell time, no condition colour, no run or cost stats. The card styling
is nonetheless built to absorb those fields without restructuring: chip row,
stats line, and condition border all exist and render empty.

**Phase B — the board read model (GAP-01).** Columns become the six derived
conditions and cards gain stage, dwell time, and spend, served by a dedicated
operator projection rather than assembled by the client.

Two of the eight condition branches have missing inputs — the frozen check
(GAP-11) and the scheduled marker (25A.7 tags). The read model must not fake
them. `condition` is a closed vocabulary; the projection simply never emits
`scheduled`, and never emits the frozen route into `needs-human`, until those
inputs exist. Phase B therefore ships without waiting on either, and gains
accuracy when they land.

**Card** adopts the legacy treatment: title, status pill, meta chips, stats
line, and a condition-coloured left border. Column headers gain counts.
Collapsible columns with `localStorage` persistence are ported from
`ui-assets.ts:293-320` — the target has no equivalent and the web surface design
§7.2 requires them on mobile.

The duplicated workflow chip in `renderCardSummaryNodes` (workflow appears both
as `chip-meta` and again in the label list) is not reproduced.

### 6.2 Work list

`DataTable` is already sound. It gains localized timestamps via the existing
`LocalTime` component and styled filter controls. Search and state filters
already function.

Stage and workflow-status columns are **not** added, for the §6.1 reason — that
data is not on `WorkItemResponse` and will arrive through GAP-01, not a join.

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
| Charts and graphing | No chart framework (web surface design §8.1). The analytics read model is phase B (GAP-13); its visual treatment stays tabular, as legacy's is |
| Light theme | Token layer makes it cheap later; no current demand |
| Drag and drop | Prohibited by web surface design §7.2 |
| Pull request panel, and any kind-aware resource presentation | §6.3.1 — needs a generic activity-presentation contract (GAP-16) |
| Event payload viewer, direction filter | GAP-06 |
| Per-work-item events tab | GAP-07 |
| Freeze, unfreeze, delete, retry, pause, resume controls | GAP-10, GAP-11 — routes return 501 |
| Status bar counters | GAP-12 |
| Routing table view | GAP-14 |

## 8. API gap register

Disposition values: **phase B** (built by this work, per §10), **cheap-now**
(unblocked and small, but out of scope here), **25A.x** / **25B** (an in-flight
rewrite packet already covers the underlying fact), **new** (needs a decision and
a task of its own).

| ID | Gap | Disposition |
| --- | --- | --- |
| GAP-01 | Board read model API | phase B — highest value; degrades without GAP-11 and 25A.7 |
| GAP-02 | Stage, workflow, and dwell time for list surfaces | phase B — folded into GAP-01 |
| GAP-03 | Tags and labels | 25A.7 |
| GAP-04 | Token and cost figures | cheap-now |
| GAP-05 | Runner and model on `RunResponse` | cheap-now |
| GAP-06 | Event direction and payload | new |
| GAP-07 | Events filtered by work item | new |
| GAP-08 | Real health checks | new (correctness) |
| GAP-09 | Runner availability | 25B |
| GAP-10 | Control-plane pause and resume | 25A.8 |
| GAP-11 | Work commands: freeze, unfreeze, delete, retry | new |
| GAP-12 | Status bar counters | phase B — cost figures need GAP-04 |
| GAP-13 | Observability windows and metrics | phase B (also a correctness fix) |
| GAP-14 | Routing table | new |
| GAP-15 | Resource browse URL | new |
| GAP-16 | Generic activity presentation contract | new |

### GAP-01 — Board read model API

The board is an operator capability — "what needs my attention" — and per §3.3 it
deserves its own read model rather than being reconstructed from domain
resources by a client.

Legacy proves the capability is real and cheap to derive. `deriveCondition`
(`ui-data.ts:53-101`) documents itself as a display-only read model that "never
decides anything the tick doesn't independently decide", and `buildBoard`
assembles condition, dwell time, workflow, stage, labels, run counts, cost, and
token spend per card. What legacy got wrong was placement: that derivation sits
inside an HTTP adapter, so it is untestable apart from the transport and
unreachable from the CLI.

**Shape.** One projection folded from the journal, registered in the production
composition root like any other, exposing per-card operator facts — condition,
current stage, workflow, dwell time, run count, spend — plus the per-condition
counts legacy computes in `buildStatus` (`ui-data.ts:282-292`). It returns facts,
not columns or colours.

**Inputs.** Most already exist: run status (`RunView.status`), workflow stage and
status (`WorkflowInstanceResponse`), terminal-stage knowledge from the compiled
workflow. Two do not: the frozen flag (GAP-11) and the scheduled marker, which
legacy reads from a label and 25A.7 replaces with WorkItem tags. Spend requires
GAP-04.

**Sequencing note.** GAP-01 is the highest-value entry in this register — it is
what makes the board a board rather than a styled list — and is built in phase B
(§10). It is not blocked on GAP-11 or 25A.7: the condition vocabulary degrades
explicitly rather than waiting, per §6.1.

### GAP-02 — Stage, workflow, and dwell time for list surfaces

`WorkItemResponse` carries `workItemKey`, `workItemId`, `objective`, `state`,
and `relatedWorkItems` (`contracts/work.ts:8-17`). Stage lives on
`WorkflowInstanceResponse` and reaches the browser only through the detail route.

**This is not fixed by extending `WorkItemResponse`.** Per §3.3, a domain-shaped
contract must not inherit fields because list screens want them. It is folded
into GAP-01 and served from the board read model, which the work list can consume
as readily as the board.

Retained as a separate entry only because it is the gap an implementer will feel
first, and the obvious wrong fix is attractive enough to warrant naming.

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

Analytics is the second operator capability identified in §3.3 and takes the
same shape as GAP-01: a projection maintained incrementally from the journal,
not an aggregate computed per request. Legacy's summary
(`ui-data.ts:621-632`) is a reasonable starting vocabulary. Windowing is what
makes a per-request scan untenable, so the read model must be designed for it
rather than having windows added to a scan.

Depends on GAP-04 for any token or cost figure.

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

- the board queries `/work-items` only — asserted by failing if any other
  collection is requested, so the withdrawn join cannot be reintroduced casually;
- board cards render their chip row, stats line, and condition border as empty
  rather than broken when those fields are absent, which is every card today;
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

### Phase A — UI only

1. Token layer and shell (§4, §5) — every later step depends on the tokens.
2. Shared components: `StatusBadge` condition tones, chips, pills, tiles.
3. Board (§6.1): card styling and collapsible columns, against `/work-items`
   alone.
4. Work list and work detail (§6.2, §6.3).
5. Events, runs, health, observability, configuration (§6.4-§6.6).
6. Contrast and accessibility pass.

Steps 3 through 5 are independent of one another once step 2 lands.

Phase A has no blocking dependency on Phase B, on Task 25A, or on Task 25C, and
the two phases can run in parallel rather than in sequence:

- 25C explicitly excludes the web workspace from its rewrite, in prose and in
  its ESLint `ignores`, so there is no file overlap.
- 25A lists no file under `src-next/surfaces/web`.
- The web e2e fixture (`e2e/surface-fixture.ts`) stands the HTTP surface up
  against a hand-written `ApiApplications` stub, with no composition root,
  journal, or projections — so Phase A is fully buildable and testable before
  the live runtime is restored.

**Consequence for review.** Until 25A wires intake, the fixture is the only place
Phase A can be seen with data in it, which makes it the de-facto design review
artifact. It currently carries a single work item. Phase A therefore includes
widening the fixture to a representative set — enough items, states, long
objectives, and empty columns to expose density and truncation problems that one
card cannot.

### Phase B — operator read models

7. Board read model (GAP-01): projection, application, presenter, route,
   registration; then the board and work list consume it.
8. Status read model (GAP-12): the counters legacy computes in `buildStatus`,
   which is the same capability at a smaller scale and reuses the board
   projection's per-condition counts.
9. Analytics read model (GAP-13), including the windowing the current
   per-request scan cannot support.

Step 7 is the value in this work; 8 and 9 are optional follow-ons and can be
dropped without invalidating it.

### Relationship to the rewrite plan

Phase B builds production surface capability and therefore belongs in the
rewrite plan's task sequence, not alongside it. It sits naturally with Task 25
("Rebuild CLI, API, and UI over public application views"), whose remit already
covers the API and UI surfaces, and should be slotted as a numbered packet with
its own gate rather than carried informally on this branch.

Conflict surface with in-flight work is small by construction: Phase B is
almost entirely new files, because §3.3 keeps operator read models out of the
domain modules that 25A and 25C are churning. The one shared touchpoint is
projection and application registration in `bootstrap/composition-root.ts`,
which 25A.8 also modifies — so Phase B should follow 25A.8 rather than race it.

**Open decision:** whether Phase B becomes a new numbered packet (a Task 25D) or
extends an existing one. That is a plan-ownership call, not a design call, and is
left to the operator.

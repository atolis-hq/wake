# Wake Web Surface Architecture Design

**Status:** Approved

**Date:** 2026-07-30

**Companion to:** [Wake Target Architecture and Rewrite Design](2026-07-30-wake-target-architecture-design.md)

**Implementation gate:** Task 25 of the [Wake Target Architecture Rewrite Implementation Plan](../plans/2026-07-30-wake-target-architecture-rewrite.md)

## 1. Executive decision

Wake will replace the legacy embedded control-plane UI with an independently
buildable React and TypeScript web application. The application is a private
npm workspace inside the `surfaces` module, is compiled by Vite, and consumes
only Wake's public, versioned, domain-shaped HTTP API.

The API is a product surface in its own right. It is not a backend-for-frontend
and does not expose screen-shaped resources such as boards, modals, status
bars, or tables. The browser derives those presentations from public domain
and operational views without reproducing domain policy.

The initial web runtime is deliberately lean:

- React and React DOM for components;
- React Router in declarative browser-history mode for shareable clean URLs;
- TanStack Query for server state, polling, mutation state, cache invalidation,
  and later selective event-driven invalidation;
- CSS Modules and Wake-owned design tokens for styling.

Wake will not initially add a component library, table library, CSS framework,
graph library, icon suite, general-purpose client state library, server-side
rendering framework, or server HTTP framework.

The HTTP surface and processor are independently usable hosts composed by the
same Wake binary:

- `wake api` starts the API without the web application;
- `wake ui` starts the API and serves the packaged web application;
- `wake start` starts the resident processor and, when configured, the API and
  web application in the same Node.js process.

Compiled web assets ship with Wake and its Docker image. `wake init` copies no
web source or compiled UI artifacts into a Wake home.

## 2. Context

The legacy UI proves useful operator capabilities, but not a maintainable
architecture. Its presentation, styling, browser behavior, API routing,
storage access, mutations, and UI-specific read-model construction are
concentrated in three large TypeScript files:

- `src/adapters/http/ui-assets.ts`;
- `src/adapters/http/ui-data.ts`;
- `src/adapters/http/ui-server.ts`.

The web application is embedded as an HTML, CSS, and JavaScript string.
Browser code has no independent type-check, build, component boundary, or
browser test lane. The server reads storage and legacy projections directly,
and several responses flatten issue, workflow, run, and provider concerns.

This design preserves accepted operator intent from the functional decision
catalogue while rejecting those implementation constraints. In particular, it
preserves the board, WorkItem inspection, run status, metrics, event/audit
views, transcripts, health information, and bounded operator commands. It
corrects issue-shaped identity, direct filesystem access, UI-shaped endpoints,
flattened cross-domain responses, and monolithic embedded assets.

The older `docs/specs/control-plane-ui.md` remains evidence of legacy
capabilities and operational learning. This document is authoritative for the
target web surface.

## 3. Goals and non-goals

### 3.1 Goals

The target web surface must:

1. expose a UI-agnostic control-plane API organized by Wake domain and
   operational capability;
2. use `WorkItemKey` as canonical work identity in URLs, requests, and links;
3. keep browser code independent from domain implementations, persistence,
   integration adapters, bootstrap, and legacy source;
4. provide a maintainable component and feature structure without prematurely
   creating a general component platform;
5. work well on modern mobile and desktop browsers with the same information
   architecture;
6. preserve useful live behavior with immediate mutation feedback and
   seconds-level reconciliation;
7. keep loading, empty, stale, error, conflict, and delayed-command behavior
   consistent across screens;
8. make large collections navigable and link rows or cards to canonical detail
   routes;
9. package one immutable web build with Wake for local and Docker execution;
10. test public contracts, user-facing component behavior, and a small number
    of complete browser journeys;
11. leave compatible extension points for authentication, OpenAPI, selected
    server-sent invalidation, and future domain visualizations.

### 3.2 Non-goals

The initial target does not include:

- authentication or authorization;
- remote or multi-user product hosting;
- OpenAPI publication or generated clients;
- server-sent events or WebSockets;
- server-side rendering;
- offline or progressive-web-application behavior;
- microfrontends or independently published components;
- workflow or WorkItem graph visualization;
- drag-and-drop workflow mutation;
- a general dashboard builder;
- three-browser Playwright coverage;
- migration compatibility for legacy UI endpoints.

These are explicit deferrals, not incomplete v1 requirements.

## 4. Ownership and dependency direction

### 4.1 Server ownership

`surfaces/api` owns HTTP transport concerns:

- versioned route registration;
- request parsing and validation;
- success response envelopes;
- RFC 9457 Problem Details mapping;
- pagination and filter parsing;
- transport DTO composition from public views;
- mapping public application command results to HTTP semantics.

API source is grouped by Wake domain or operational capability, not by browser
screen:

```text
src-next/surfaces/api/
  contracts/
    common.ts
    control-plane.ts
    work.ts
    resources.ts
    orchestration.ts
    execution.ts
    activities.ts
    events.ts
    observability.ts
    system.ts
    index.ts
  presenters/
    control-plane.ts
    work.ts
    resources.ts
    orchestration.ts
    execution.ts
    activities.ts
    events.ts
    observability.ts
    system.ts
  routes/
    control-plane.ts
    work.ts
    resources.ts
    orchestration.ts
    execution.ts
    activities.ts
    events.ts
    observability.ts
    system.ts
  http-server.ts
  problem-details.ts
  router.ts
```

Route handlers call only public module applications and views injected through
the Surface composition contract. They do not import repositories, journals,
projection stores, filesystem paths, provider clients, concrete adapters, or
bootstrap.

Node.js 24's stable `node:http` and `URLPattern` APIs are sufficient for this
bounded surface. A small explicit route table plus focused response helpers
avoid both the legacy monolithic handler and a new server framework dependency.

### 4.2 Web-host ownership

`surfaces/web-host` owns serving the compiled application:

```text
src-next/surfaces/web-host/
  asset-source.ts
  packaged-assets.ts
```

The HTTP server receives a replaceable `WebAssetSource`. The packaged
implementation resolves assets relative to the compiled Surface module.
`index.html` is served with revalidation/no-cache semantics. Content-hashed
JavaScript, CSS, fonts, images, and source maps use immutable caching where
appropriate.

The host applies SPA fallback only to `GET` or `HEAD` paths that:

- are not beneath `/api/`;
- are not known static-asset paths;
- do not contain a file extension.

Unknown API and asset routes remain ordinary 404 responses.

### 4.3 Browser ownership

The browser application is a private npm workspace:

```text
src-next/surfaces/web/
  package.json
  tsconfig.json
  vite.config.ts
  vitest.config.ts
  playwright.config.ts
  index.html
  src/
    main.tsx
    app/
      providers.tsx
      router.tsx
      shell.tsx
    api/
      client.ts
      errors.ts
      query-keys.ts
    components/
    features/
      board/
      work/
      events/
      runs/
      observability/
      health/
      configuration/
    styles/
      global.css
      tokens.css
  test/
  e2e/
```

The web workspace imports only the transport contract entry point exposed by
`surfaces/api/contracts`. Architecture checks reject imports from:

- Wake domain or application implementations;
- persistence;
- integrations;
- bootstrap;
- server routes and presenters;
- Node.js APIs;
- legacy `src/**`.

Transport contracts are JSON-compatible DTOs. The browser does not receive a
global Wake application graph and does not import public domain modules
directly.

### 4.4 Cross-domain composition

A resource endpoint may compose public views from several domains when the
resource requires a joined operator view. It must retain ownership and
provenance:

```json
{
  "work": {},
  "orchestration": {},
  "execution": {},
  "resources": [],
  "activities": {}
}
```

The server must not flatten workflow position, WorkItem lifecycle, Run status,
resource identity, or specialist Activity state into one ambiguous object.

The board is a browser projection of WorkItem summaries. Eligibility, waiting
reason, failure classification, runner availability, and other policy-derived
facts come from their owning server views. The browser does not duplicate Wake
policy to calculate them.

## 5. Runtime and configuration

### 5.1 One binary, three host modes

The Surface composition root supports:

| Command | Processor | API | Web assets |
| --- | --- | --- | --- |
| `wake api` | no | yes | no |
| `wake ui` | no | yes | yes |
| `wake start` | yes | configured | configured |

`wake api` and `wake ui` are useful for development, inspection, and
independent consumers. `wake start` is the normal resident product host and
can run enabled HTTP surfaces in the same Node.js process. Each host receives
the same public application facades from bootstrap.

The HTTP server has an independent startup result and graceful close
capability. A handled API request failure cannot terminate the resident loop.
Startup failures are explicit: Wake must not report that an enabled surface is
available when its port cannot bind or its packaged assets are absent.

### 5.2 Configuration

Surface-owned configuration extends the target shape:

```yaml
surfaces:
  api:
    enabled: false
    host: 127.0.0.1
    port: 4317
  web:
    enabled: false
```

Rules:

- `api.enabled` controls API startup under `wake start`;
- `web.enabled` requires `api.enabled` and adds packaged assets to that same
  origin;
- `wake api` and `wake ui` explicitly select their respective host modes
  regardless of resident enablement;
- command-line host and port overrides remain host concerns and do not mutate
  configuration;
- there is no authentication configuration in v1.

The unauthenticated service is locally scoped. It binds loopback by default.
A container may bind its internal interface while publishing the port only to
host loopback. Authenticated remote exposure is a later design and must not be
simulated with an undocumented public bind.

### 5.3 Packaging

During the side-by-side rewrite, Vite writes the production web build to:

```text
dist-next/src-next/surfaces/web-assets/
```

After atomic cutover, the equivalent package path is:

```text
dist/src/surfaces/web-assets/
```

That location stays adjacent to the compiled Surface host and is already
inside the npm package's `dist/src` payload after cutover. The Docker source
build runs the root build, which includes the web build. The packaged Docker
image obtains the same assets from the installed npm package.

No build output is written beneath a Wake home. `wake init` continues to
scaffold only human-owned configuration, prompts, and workspace structure.

## 6. HTTP API contract

### 6.1 Resource groups

The v1 API is rooted at `/api/v1` and grouped by domain or operational
capability. Its initial required read routes are:

```text
/api/v1/control-plane/status
/api/v1/work-items
/api/v1/work-items/:workItemKey
/api/v1/resources
/api/v1/workflow-instances
/api/v1/runs
/api/v1/runs/:runId
/api/v1/runs/:runId/transcript
/api/v1/runners
/api/v1/events
/api/v1/observability/metrics
/api/v1/system/health
/api/v1/system/configuration
```

New routes follow the owning domain or capability. UI-shaped aliases remain
prohibited.

Commands nest beneath the resource that owns the command. The initial required
command routes are:

```text
POST /api/v1/control-plane/commands/pause
POST /api/v1/control-plane/commands/resume
POST /api/v1/control-plane/commands/advance
POST /api/v1/work-items/:workItemKey/commands/freeze
POST /api/v1/work-items/:workItemKey/commands/unfreeze
POST /api/v1/work-items/:workItemKey/commands/delete
POST /api/v1/work-items/:workItemKey/commands/retry
POST /api/v1/runners/:runnerId/commands/unpause
```

Handlers call public application commands. They do not append events, write
files, rebuild projections, or invoke provider adapters directly. Commands
accept or derive a stable idempotency key and return the accepted command
identity plus the public result or current conflict state.

### 6.2 Success responses

One resource uses:

```ts
export interface ResourceResponse<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}
```

A collection uses:

```ts
export interface CollectionResponse<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly total?: number;
  };
  readonly meta: ResponseMeta;
}
```

Shared metadata is:

```ts
export interface ResponseMeta {
  readonly asOf: string;
  readonly position?: number;
}
```

`asOf` is the timestamp of the newest contributing fact or sample, not merely
the time JSON serialization happened. `position` is included when the result
is derived from a known durable journal position.

Collections use opaque cursor pagination. This avoids offset drift while Runs
or events are appended. `total` is optional and omitted where computing it
would require an expensive scan.

Filters, sorting, pagination cursors, and time windows use query parameters.
The browser keeps those parameters in the URL when they affect a shareable
view.

### 6.3 Errors

All API errors use RFC 9457 Problem Details with
`application/problem+json`. Standard members are:

```ts
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
}
```

Wake-defined extension members are:

```ts
export interface WakeProblemDetails extends ProblemDetails {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly current?: unknown;
  readonly violations?: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}
```

Clients branch on HTTP status, `type`, or stable `code`; they never parse
`detail`. Domain conflicts normally map to 409, invalid input to 400 or 422,
missing resources to 404, and unexpected faults to 500. Problem responses do
not expose stack traces, filesystem paths, secrets, raw provider payloads, or
other implementation internals.

### 6.4 Time contract

Canonical API timestamps are RFC 3339/ISO 8601 UTC strings with a `Z` suffix.
The server never sends locale-formatted dates.

The browser:

- renders timestamps with `Intl.DateTimeFormat` using the browser locale and
  local time zone;
- makes the exact UTC value available in audit/event detail and copy actions;
- gives every relative timestamp an accessible absolute timestamp;
- keeps configured schedule time zones explicit rather than silently treating
  them as browser-local;
- treats date-only domain values as dates, not midnight timestamps.

API filters that accept instants use UTC RFC 3339 values. Tests fix locale and
time zone where deterministic output matters and cover daylight-saving
boundaries.

### 6.5 Future OpenAPI compatibility

Transport contracts, stable Problem Details, explicit pagination, and domain
route grouping are the seam for future OpenAPI publication. V1 does not add
schema generation, generated bindings, decorators, or framework-specific
contract machinery. The need for an independently released or non-TypeScript
consumer will trigger that work.

## 7. Browser information architecture

The browser is organized around operator tasks:

| Route | Purpose |
| --- | --- |
| `/board` | Condition-oriented Kanban overview |
| `/work` | Searchable and filterable WorkItem list |
| `/work/:workItemKey` | Canonical WorkItem detail |
| `/events` | Event and audit exploration |
| `/runs` | Execution history |
| `/runs/:runId` | Run detail |
| `/observability` | Analytics, trends, and operational insight |
| `/health` | Current readiness, faults, and runner availability |
| `/configuration` | Redacted effective configuration |

The root redirects to `/board`. Browser-history routing is mandatory; hash
routing is prohibited. Navigation uses real anchors through React Router so
links can be opened in a new tab, copied, bookmarked, and restored.

The server's SPA fallback makes a direct request or reload of
`/work/<workItemKey>` return the application shell. The router then renders the
same canonical detail resource.

### 7.1 WorkItem detail presentation

When navigation originates from the board or WorkItem list on a desktop
viewport, the detail route may render as a route-backed modal over the
originating view. The browser URL still becomes `/work/:workItemKey`.

A direct load of that URL renders the complete detail page. Mobile always uses
the full-page presentation. Both presentations share the same detail feature,
query, sections, actions, and error handling.

This preserves fast board inspection without making modal state unshareable or
creating a second item-detail implementation.

### 7.2 Board

The mature column/card structure is retained:

- desktop uses horizontally arranged columns;
- mobile uses vertically stacked, collapsible columns;
- cards use WorkItem key routes and real links;
- column and card status includes text or icon meaning in addition to color;
- card actions do not replace the primary navigation target;
- board grouping consumes server-owned eligibility and waiting facts.

Drag and drop is excluded. A visual move must not imply a workflow command that
the domain has not defined.

### 7.3 Events, Runs, and audit activity

Events and Runs are navigable collections with stable row identity and cursor
pagination. Rows link to WorkItem or Run detail where an owning identity
exists. Event detail separates canonical facts from integration diagnostics.

Raw JSON is not the normal presentation. One shared `JsonViewer` provides
collapsible, copyable diagnostic evidence where the raw structured value is
itself useful. Ordinary WorkItem, workflow, Run, resource, health, and
configuration data receive labelled domain presentation.

### 7.4 Observability, health, and configuration

Observability explains trends and behavior across a selected time window.
Health explains whether Wake can operate safely now. They remain separate
routes and API capabilities.

Runner availability belongs with current health/status presentation, not
static configuration. Effective configuration is redacted, read-only, and
does not poll automatically.

## 8. Component and styling strategy

### 8.1 Initial shared components

The initial shared component layer is limited to demonstrated cross-feature
behavior:

- `AppShell`;
- primary and compact navigation;
- `PageHeader`;
- `Button` and link-button presentation;
- `StatusBadge`;
- `Panel`;
- `DataTable`;
- `LoadingState`;
- `EmptyState`;
- `ErrorState`;
- `StaleIndicator`;
- `JsonViewer`;
- confirmation and mutation-feedback primitives.

A component remains inside its feature until at least two features need the
same behavior and semantics. Shared components expose presentation contracts,
not Wake domain policy.

### 8.2 Tables

`DataTable` begins as a Wake-owned semantic HTML table. It standardizes:

- accessible captions and column headings;
- loading, empty, error, and stale states;
- row links without invalid nested interactive controls;
- server-driven sorting, filters, and cursor pagination;
- responsive horizontal overflow;
- compact cells and optional secondary labels on narrow viewports.

No table library or virtualization library is installed initially. A measured
need for complex client-side column state or very large in-memory collections
can justify one later. High-volume event feeds use incremental pages and a
bounded client buffer instead of rendering an unbounded table.

### 8.3 CSS

Global CSS defines reset/base behavior and Wake design tokens for:

- color and status semantics;
- spacing;
- typography;
- borders, radius, and elevation;
- focus rings;
- content widths and breakpoints;
- motion duration.

Feature and component styles use CSS Modules. The design does not add Tailwind,
CSS-in-JS, or a third-party theme system.

The layout is mobile-first. Desktop and mobile use the same routes, domain
language, and actions. Responsive presentation may change navigation density,
column stacking, table overflow, and detail modal/page treatment without
creating separate mobile components.

### 8.4 Accessibility

The baseline requires:

- semantic landmarks, headings, lists, tables, links, and buttons;
- visible keyboard focus;
- logical focus restoration for route-backed dialogs;
- keyboard operation for navigation, board cards, collapsible columns, tables,
  dialogs, and menus;
- accessible names and descriptions;
- status meaning independent of color;
- polite live regions for mutation outcomes and buffered-update counts;
- respect for reduced-motion preferences;
- no automatic focus or viewport movement when live data arrives.

Native platform elements are preferred. A focused accessible primitive
dependency can be proposed later only when a complex interaction cannot be
implemented and maintained safely with the platform.

## 9. Client data flow and live behavior

### 9.1 Query ownership

One typed API client owns:

- base URL construction;
- JSON serialization and decoding;
- request cancellation;
- success envelope decoding;
- Problem Details decoding;
- common headers.

The client is grouped by the same API domains and capabilities as the server.
It does not expose methods named after screens.

TanStack Query owns remote server state. Query keys are created centrally by
domain resource and parameters. Components do not copy query results into
general global state. URL state owns shareable filters and selections; local
component state owns transient presentation such as an expanded JSON section.

React mounts once. Polling, mutations, and navigation exchange JSON only.
There is no full-document or server-generated HTML replacement after the
initial load. Query subscriptions re-render only the affected component tree.

### 9.2 Refresh policy

Default automatic refresh intervals are:

| Data | Default behavior |
| --- | --- |
| Top control-plane status | poll every 2 seconds |
| Board WorkItem summaries | poll every 3 seconds |
| Open WorkItem detail | poll every 3 seconds |
| Active Runs | poll every 3 seconds |
| Historical Runs | poll every 5 seconds while visible |
| Events/audit | incremental poll every 3 seconds |
| Health and runner availability | poll every 5 seconds |
| Observability analytics | no interval; explicit refresh/window change |
| Effective configuration | no interval; explicit refresh |

Background tabs stop or substantially reduce interval polling. Window focus
and network reconnection revalidate active operational queries. Cached content
stays visible during a background refresh and carries a refreshing or stale
indicator where the distinction matters.

### 9.3 Mutations

A mutation:

1. disables duplicate submission for its stable command key;
2. shows immediate pending feedback in the affected component;
3. sends a typed command with an idempotency key;
4. applies confirmed response data to the narrowest relevant cache;
5. invalidates related WorkItem, status, Run, health, or observability queries;
6. reconciles through the next authoritative fetch;
7. maps a Problem Details conflict to an actionable current-state message.

Reversible local presentation can update immediately, but destructive,
externally mediated, or policy-sensitive work is never shown as completed
before the server confirms acceptance or outcome.

Navigation during a mutation remains possible unless leaving would discard
unsent operator input. Long-running commands return accepted identity and
state; the UI follows resulting domain views rather than holding one HTTP
request open for the entire operation.

### 9.4 High-volume live views

Event, audit, and Run feeds use opaque incremental cursors. They do not refetch
or replace the entire visible collection on each interval.

Each high-volume view provides `Pause live view`. This pauses browser
presentation updates only; it never pauses Wake. The view also leaves live
mode automatically when the operator scrolls away from the newest records.

Incoming records are buffered while paused or scrolled away. The page displays
an accessible count such as `17 new events`. Applying that notice merges the
buffer in stable order and returns to live mode without losing selection.
Automatic updates never move the viewport while the operator is reading.

The client retains a bounded recent window plus pagination cursors. Historical
pages remain available from the server without keeping an unbounded browser
array.

### 9.5 Future server-sent invalidation

The future live transport is Server-Sent Events rather than WebSockets unless
a bidirectional streaming requirement appears.

SSE messages will carry only:

- a durable position or version;
- affected domain topics or resource identities;
- optional event kind needed to choose invalidation.

They will not carry screen payloads or replace the resource API. TanStack Query
will map an invalidation signal onto existing query keys and refetch the same
HTTP resources. Selected hot areas can adopt SSE independently while polling
remains a fallback and reconciliation mechanism.

## 10. Loading, errors, and delayed responses

Every route and reusable collection supports:

- first-load skeleton or labelled progress;
- cached content with background-refresh indication;
- empty state with domain-specific explanation;
- recoverable error with retry;
- stale data indicator when the last successful response is retained;
- Problem Details conflict presentation;
- offline/reconnecting status;
- explicit mutation pending and outcome feedback.

Navigation does not blank the entire application shell. Cached destination
data renders immediately when available. A lightweight route progress
indicator covers delayed first navigation.

Errors are bounded at route and feature level so one failed panel does not
erase unrelated status or navigation. The top status bar reports connectivity
to the HTTP surface separately from Wake's own control-plane state.

## 11. Testing strategy

### 11.1 API and contract tests

API tests run the real HTTP handler in-process against public application
services and deterministic in-memory/fake system boundaries. They verify:

- route and method matching;
- request validation;
- domain-shaped resource and collection envelopes;
- WorkItem-key identity;
- cursor behavior;
- timestamps and response metadata;
- Problem Details and conflict extensions;
- idempotent command mapping;
- absence of storage and provider payload leakage;
- static-asset cache behavior;
- clean-path SPA fallback and API/asset 404 behavior.

The browser compiles against the same transport-only contract entry point.
The API client accepts an injected `fetch` implementation for tests. V1 does
not add a standalone mock server or request-interception package.

### 11.2 Component and feature tests

Vitest, jsdom, React Testing Library, and user-event cover behavior through
roles, names, links, and visible state. Tests cover:

- loading, cached refresh, empty, error, stale, and reconnecting states;
- clean route generation;
- desktop and mobile detail presentation decisions;
- mutation pending, success, conflict, and duplicate suppression;
- board column/card behavior;
- table navigation and pagination;
- event buffer, pause, count, and resume behavior;
- local date formatting, exact UTC access, and daylight-saving boundaries;
- keyboard and focus behavior.

Pure formatters, query-key factories, response decoders, and browser
projections receive focused unit tests. Broad component snapshots are
prohibited; assertions describe behavior and semantics.

### 11.3 Browser tests

Playwright uses Chromium only, with representative desktop and mobile viewport
projects. It starts Wake's real HTTP surface composed with deterministic test
applications; it does not run a separately maintained fake API.

The initial browser suite covers:

1. application shell, status, and board load;
2. clean URL navigation and direct WorkItem deep-link reload;
3. desktop route-backed detail modal and mobile full-page detail;
4. a bounded mutation with immediate pending state and authoritative
   reconciliation;
5. Problem Details conflict and retryable failure;
6. incremental events with pause, buffered count, and resume;
7. health and runner-availability refresh;
8. keyboard navigation and serious automated accessibility violations.

Playwright is not used to enumerate every formatter, card condition, API error,
or table cell. Those remain faster component and contract tests.

### 11.4 Build and architecture gates

The web workspace provides:

```text
npm run build
npm run test
npm run test:e2e
```

The root package provides:

```text
npm run build:web
npm run test:web
npm run test:web:e2e
```

Task 25 verification runs:

```powershell
npm run build:web
npm run test:web
npm run test:web:e2e
npx vitest run --config vitest.next.config.ts test-next/surfaces test-next/e2e/scenarios/api-domain-shape.test.ts
npm run verify:next
npm test -- test/cli/main.test.ts test/cli/audit-command.test.ts test/adapters/ui-server.test.ts test/adapters/ui-data.test.ts
```

`verify:next` includes the web type-check, production build, component tests,
and import-boundary check after Task 25. The explicit Playwright command
remains a required Task 25 and Packet E gate because browser installation is a
distinct CI concern.

The initial JavaScript entry budget is 150 KiB gzip. A future visualization
dependency must be route-lazy-loaded and must not increase the normal
board/WorkItem entry bundle beyond that budget.

## 12. Task 25 incorporation contract

Before Task 25 production code begins, its deferred web entry must be replaced
with this exact target set.

### 12.1 Create

```text
src-next/surfaces/api/contracts/{common,control-plane,work,resources,orchestration,execution,activities,events,observability,system,index}.ts
src-next/surfaces/api/presenters/{control-plane,work,resources,orchestration,execution,activities,events,observability,system}.ts
src-next/surfaces/api/routes/{control-plane,work,resources,orchestration,execution,activities,events,observability,system}.ts
src-next/surfaces/api/{http-server,problem-details,router}.ts
src-next/surfaces/web-host/{asset-source,packaged-assets}.ts
src-next/surfaces/web/package.json
src-next/surfaces/web/tsconfig.json
src-next/surfaces/web/vite.config.ts
src-next/surfaces/web/vitest.config.ts
src-next/surfaces/web/playwright.config.ts
src-next/surfaces/web/index.html
src-next/surfaces/web/src/**
src-next/surfaces/web/test/**
src-next/surfaces/web/e2e/**
```

### 12.2 Modify

```text
package.json
package-lock.json
tsconfig.next.json
vitest.next.config.ts
dependency-cruiser.config.mjs
knip.next.json
src-next/surfaces/index.ts
src-next/surfaces/contracts/config.ts
src-next/bootstrap/composition-root.ts
docker/Dockerfile
docker/Dockerfile.packaged
test-next/architecture/**
test-next/surfaces/**
test-next/e2e/scenarios/api-domain-shape.test.ts
docs/architecture/functional-decision-catalogue.md
```

Task 25 must not create `src-next/surfaces/ui/data.ts`; domain presenters and
the typed client replace that deferred legacy-shaped boundary.

### 12.3 Dependencies

Runtime web dependencies:

```text
react
react-dom
react-router
@tanstack/react-query
```

Development web dependencies:

```text
vite
@vitejs/plugin-react
typescript
vitest
jsdom
@testing-library/react
@testing-library/user-event
@playwright/test
@axe-core/playwright
```

No other frontend or HTTP framework dependency is authorized by this design.
An implementation-discovered need requires an explicit design amendment.

### 12.4 Required Task 25 assertions

In addition to the plan's existing Surface assertions, Task 25 must prove:

```ts
it('groups API routes and clients by domain capability rather than UI screen');
it('uses WorkItemKey in canonical routes and links');
it('serves clean browser-history routes without intercepting API or asset 404s');
it('does not import Wake implementations into the web workspace');
it('ships compiled assets without writing them into a Wake home');
it('renders domain updates without replacing the application document');
it('reconciles a confirmed mutation immediately and through polling');
it('buffers high-volume live records while the operator is paused or reading history');
it('emits UTC timestamps and localizes them only in the browser');
it('uses Problem Details for API failures');
```

## 13. Extension rules

### 13.1 Authentication

Authentication will be introduced at the HTTP Surface boundary. Route handlers
will receive an authenticated principal/authority result rather than read
credentials themselves. Domain applications continue to validate domain
authority where applicable. Adding authentication must not change resource
shapes or turn the API into a UI session backend.

### 13.2 New domain components

A future workflow visualization, WorkItem graph, or specialist domain
component belongs under its browser feature. It consumes the same typed API
client and design tokens. A graph library is selected for the demonstrated
interaction and loaded only on that route.

A component becomes separately embeddable or independently published only
after a second consumer exists and its API has been demonstrated. The initial
application has no microfrontend or plugin runtime.

### 13.3 New API consumers

New consumers use the same `/api/v1` domain resources and Problem Details.
They do not cause aliases named after current UI screens. A non-TypeScript or
independently released consumer is the trigger to publish OpenAPI and consider
generated bindings.

## 14. Success criteria

The web architecture is successfully implemented when:

1. the browser application is independently type-checked, built, and tested;
2. no web source is embedded in a TypeScript string;
3. no browser import reaches Wake implementations or legacy source;
4. API resources and clients are grouped by domain/capability rather than
   screen;
5. WorkItem-key clean URLs survive direct reload and remain shareable;
6. the board, WorkItem detail, top status, Runs, events/audit, health, and
   runner availability update without full-document replacement;
7. analytics and configuration remain stable until explicit refresh;
8. high-volume feeds can pause and buffer without moving the viewport;
9. success, pagination, time, and Problem Details contracts are consistent;
10. mobile and desktop Playwright journeys pass in Chromium;
11. packaged and Docker builds contain the web assets;
12. `wake init` creates no web artifacts;
13. the initial JavaScript entry stays within 150 KiB gzip;
14. Task 25 Surface, E2E, legacy evidence, and web verification gates pass.

# API Application — Component Specification

## Type, purpose, and scope

Surface application. The API application is the HTTP query/command routing
surface for Wake's API: for a given method, path, query string, and body it
decides which domain application to call, how to validate the request, and
how to shape the response — independent of byte-level HTTP transport, which
belongs to the [HTTP transport](http-transport.spec.md) adapter.

## Ubiquitous language

- **Singleton route** — a fixed path returning one resource with no path
  parameter (e.g. control-plane status, system health).
- **Collection route** — a fixed path returning a page of items, accepting
  `cursor`/`limit` and route-specific filters.
- **Detail route** — a path with one identifier segment returning one
  resource (e.g. a work item or run by id).
- **Command route** — a `POST` path invoking a state-changing operation,
  always carrying an idempotency key.
- **Collection query** — the parsed, validated `{cursor, limit, search,
  state}` shape a collection or detail read is served from.
- **Accepted result** / **conflict result** — the two shapes a domain
  application's command call can return: a successful acceptance, or a
  conflict describing why the command could not be applied.

## Responsibilities and boundaries

Owns:

- Matching a request's method and path to a specific domain call.
- Validating query parameters (an allow-list per route, limit bounds, cursor
  decoding, search/state length bounds) and command request bodies (a
  single, bounded idempotency key field).
- Presenting each domain view into its declared API response contract.
- Shaping conflict, unavailable-capability, not-found, and invalid-input
  failures into problem responses.

Does not own:

- HTTP wire transport: headers, content-length, chunked request body
  reading, or static asset serving. That is the HTTP transport adapter.
- The actual accept/reject decision for a command. That belongs to the
  domain application this component calls; this component only forwards
  that decision's shape.
- Browser-side decoding of its own responses. That is the Web API client.

## Core policies, invariants, and behaviours

- `GET`/`HEAD` requests MUST be tried against singleton, collection, and
  detail read routes, in that order, before any command route is
  considered; `POST` requests MUST be tried against command routes only
  after no read route matches. A request under `/api/` matching no route
  MUST return a not-found problem response.
- Query validation is allow-list driven per route: an unknown parameter
  name, or a parameter supplied more than once, MUST be rejected as an
  invalid-query failure before any domain call is made. A route that
  accepts no query parameters MUST reject any non-empty query string.
- Collection paging: `limit` MUST be an integer from 1 to 200 (default 50)
  or the request is rejected; `cursor`, when present, MUST decode to a
  non-negative integer position or the request is rejected; `search` MUST
  be at most 200 characters (trimmed, omitted from the query when empty);
  `state` MUST be a non-empty string of at most 100 characters.
  `/observability/metrics` uses its own single parameter, `days`, an
  integer from 1 to 31 (default 7), validated the same way.
- A collection response's `hasMore`/`nextCursor` MUST be derived from
  whether the domain application reports more items than the requested
  limit (or supplies an explicit continuation/next position); a caller
  never has to infer paging state from a raw item count.
- A command request body MUST be a JSON object containing exactly one
  field, `idempotencyKey`, a non-empty string of at most 200 characters; any
  other shape MUST be rejected as an invalid-request failure before the
  command reaches the domain application. The explicit ambiguous-Run failure
  resolution command additionally requires a non-empty `message` of at most
  2000 characters and accepts no other field.
- A conflict result returned by a domain application MUST be presented as a
  409 problem response carrying the domain's own conflict code, retryable
  flag, and current state (when supplied). An accepted result MUST be
  presented as its own resource envelope, using the domain's own
  `acceptedAt` timestamp as the envelope's freshness marker when the domain
  supplies one.
- `freeze`/`unfreeze` commands complete synchronously at this boundary and
  MUST return HTTP 200; `delete`/`retry`, control-plane, and runner commands
  are accepted for asynchronous processing and MUST return HTTP 202.
- `POST /api/v1/runs/:runId/commands/resolve` is a synchronous operator
  command. Its strict body includes `idempotencyKey` and exactly one of
  `{ status: "succeeded", outcome: ... }` or `{ status: "failed", reason: "..." }`.
  It returns HTTP 200 with the resolved Run resource. Invalid outcomes return
  a 422 problem, and a Run that is missing or not an escalated ambiguity
  returns the normal 404 or 409 problem.
- The control-plane `tick` command MUST be rejected as a 409 conflict (code
  `paused`, carrying the current control-plane status) before it reaches the
  domain application, whenever that status reports the control plane as
  paused; `pause` and `resume` are never blocked this way.
- A command or read capability absent from the composed `ApiApplications`
  facade for the current runtime (for example `board`, `status`,
  `execution.runners`, or `work.freeze`) MUST be presented as a 409 conflict
  with code `command-unavailable`, including the resource's current state
  where cheaply available, rather than a 404.
- A malformed path segment (invalid percent-encoding) MUST be rejected as an
  invalid-path failure before it reaches any domain application.
- A WorkItem's detail response MUST nest `work`, `resources`,
  `orchestration` (`primary`/`children`), `execution` (`runs`,
  `transcriptGroups`), and
  `activities` as separate keys, never flattened, per the module's
  cross-domain nesting invariant.
- A WorkItem detail's `execution.transcriptGroups` is the transcript-group
  index. `GET /api/v1/work-items/:workItemKey/transcripts/:groupId` reads one
  selected group, while `GET /api/v1/runs/:runId/transcript` remains the
  direct run deep link. The group read identifies its selected `groupId`; the
  run read identifies its requested `runId` and includes `groupId` only when
  an artifact group is available. Both use the same CLI-neutral ordered
  `input` (prompt) and `agent` (response) entries with text, time, run, group,
  and optional run duration metadata.
- The board collection response MUST additionally carry `conditionCounts`
  alongside its paginated `items`, giving one combined snapshot-plus-listing
  shape for that route.
- Exposed system configuration MUST have every key matching `secret`,
  `token`, `password`, `credential`, or `key` (case-insensitive) replaced
  with a fixed redaction marker, recursively through nested objects and
  arrays.
- Closed-vocabulary values that cross this boundary (command status, board
  condition, response field names the web client also reads) MUST be
  compared and constructed via the shared exported constants in
  `transport-values.ts`, never as ad hoc string literals.
- A resource's `locatorLabel` MUST be presented as its kind followed by its
  external key (`"<kind> <externalKey.key>"`); its `externalUrl` MUST be
  resolved through the injected `ResourceLinkResolver` and omitted whenever
  the resolver reports no link.
- A run's `sentinel` MUST be derived from the run's own activity outcome kind
  (`DONE`/`REJECTED`/`BLOCKED`/`FAILED`/`WAITING`), falling back to the run's
  own status uppercased when no outcome is present yet; `totalTokens` and
  `totalCostUsd` MUST be aggregated from the run's agent metadata rather than
  left for the caller to compute.

## Conceptual schema

**Collection query**

| Field | Type | Description |
| --- | --- | --- |
| `cursor` | opaque position cursor, optional | Decodes to a non-negative integer offset into the underlying list. |
| `limit` | integer, 1-200 | Maximum items to return; defaults to 50. |
| `search` | string, ≤200 chars, optional | Free-text filter, route-dependent. |
| `state` | string, ≤100 chars, optional | State/status filter, route-dependent. |

**Command request**

| Field | Type | Description |
| --- | --- | --- |
| `idempotencyKey` | string, non-empty, ≤200 chars | Caller-supplied token identifying this exact command attempt. |

**Command result**

| Field | Type | Description |
| --- | --- | --- |
| `commandId` | command identity | Present on an accepted result; identifies the accepted command instance. |
| `idempotencyKey` | string | Echoes the request's idempotency key. |
| `acceptedAt` | UTC instant | When the domain application accepted the command. |
| `status` | closed vocabulary: `accepted` / `completed` | Whether the command is still processing or already resolved. |
| `result` | Response envelope, optional | Present only on a control-plane advance result; nests the resulting status resource. |
| `conflict` | boolean, present only on a conflict result | Discriminates a conflict result from an accepted one. |
| `code` | closed vocabulary | Machine-comparable conflict reason on a conflict result. |
| `current` | domain view, optional | The state that caused the conflict, when available. |

**Selected transcript-group response**

| Field | Type | Description |
| --- | --- | --- |
| `groupId` | string | Safe session or run group identity. |
| `available` | boolean | Whether the requested artifact group remains available. |
| `entries` | ordered list | CLI-neutral conversation entries: `input` for the exact prompt and `agent` for the raw response, each with occurrence time, text, run ID, and group ID; response entries may include run duration. |

**Run transcript response**

| Field | Type | Description |
| --- | --- | --- |
| `runId` | string | Requested run identity. |
| `groupId` | string, optional | The safe transcript-group identity when an artifact group is available for the run. |
| `available` | boolean | Whether transcript artifacts for the requested run remain available. |
| `entries` | ordered list | The same CLI-neutral conversation entry shape as a selected transcript-group response, filtered to the requested run. |

## Dependencies and system role

- [HTTP transport](http-transport.spec.md) — supplies the `ApiDispatcher`/
  `ApiHttpResponse` contracts this component's dispatcher implements; HTTP
  transport in turn depends on this component's dispatcher factory to serve
  real requests.
- Work, Resources, Orchestration, Execution, Control-plane, Observability,
  System (via the `ApiApplications` facade Bootstrap composes) — the actual
  source of every response's data and every command's accept/reject
  decision; this component holds none of that state itself. Resources also
  supplies the `ResourceLinkResolver` and Execution the token-usage helper
  this component's presenters call to derive `externalUrl` and
  `totalTokens`/`totalCostUsd`.
- [Web API client](../web/web-api-client.spec.md) (depends on this
  component) — treats this component's response and problem shapes as its
  wire contract; a breaking change here is a breaking change for the web
  client.
- Kernel — closed-vocabulary helpers for this component's own transport
  vocabularies.

## Decisions, exclusions, and deferred capability

- No authorization check is performed by this component; per the module's
  decision, that is anticipated but not yet implemented.
- Only `GET`/`HEAD` reads and `POST` commands are dispatched; there is no
  `PUT`/`PATCH`/`DELETE` verb in the current route surface — deletion is
  expressed as a `POST` command route (`.../commands/delete`).
- The `activities` response contract currently only ever contributes a
  `pullRequest` entry to a WorkItem's detail response.

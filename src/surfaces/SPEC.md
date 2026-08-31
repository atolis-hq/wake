---
asOf: dd708e68
---

# Surfaces — Module Specification

## Purpose and scope

Surfaces is the presentation boundary of Wake: every way a human, an external
tool, or the packaged web UI reaches Wake's public applications and views. It
owns three sub-areas — an HTTP API, a CLI, and a browser-facing web client —
that together translate outside requests into calls against domain modules'
already-composed public applications, and translate domain results back into
a transport-appropriate shape. Surfaces holds no domain policy of its own:
every decision about whether a command is accepted belongs to the domain
module that receives it.

## Responsibilities and boundaries

Surfaces owns:

- Parsing an inbound HTTP request or CLI invocation into a typed query or
  command against a domain module's public application.
- Formatting a domain result (view, command outcome, or rejection) into the
  transport's response shape — JSON resource/collection envelopes and
  RFC 7807-style problem responses over HTTP; JSON lines over the CLI.
- The web client's own request construction and response decoding, so the
  packaged UI never handles an untyped HTTP payload directly.
- Presentation-level identity translation: encoding/decoding the public
  `WorkItemKey` used across the HTTP and web boundary, distinct from the
  internal `WorkItemId` a domain module owns.
- Redacting secret-shaped configuration values and process log fields before
  they leave the process.

Surfaces does not own:

- Domain policy: whether a command is valid, whether a WorkItem is in an
  acceptable lifecycle state, how a workflow advances. Those decisions are
  made by the domain module a route or command delegates to; Surfaces only
  forwards that module's own accept/reject result.
- Storage or event persistence: Surfaces never appends to or reads directly
  from an event journal, store, or projection table. It calls a public
  application or view.
- Composition: Surfaces defines the interfaces a concrete facade must
  satisfy (`ApiApplications`, `WakeCliApplications`); Bootstrap is the only
  place that builds and supplies that facade.
- Adapter clients: Surfaces does not talk to GitHub, Docker, or an agent
  runner directly; those integrations sit behind the domain applications it
  calls.

## Event transport boundary

Surfaces does not publish or reconstruct events. Where a public API, CLI, or
web transport exposes an event, it flattens the internal envelope only at that
boundary to preserve the external response shape; stream and journal metadata
remain derived from the recorded envelope.

## Ubiquitous language

- **Surface** — one of the three request-handling sub-areas: API (HTTP),
  CLI, Web (browser client).
- **Surface application** — the interface a sub-area's transport code is
  written against (`ApiApplications`, `WakeCliApplications`); Bootstrap
  supplies the concrete implementation.
- **Response envelope** — the two shapes every successful API response
  takes: a single-resource envelope (`data` plus `meta`) or a collection
  envelope (`items`, `page`, `meta`).
- **Problem response** — an RFC 7807-shaped failure body (`type`, `title`,
  `status`, optional `detail`/`code`/`retryable`/`current`/`violations`)
  returned for every rejected API request.
- **WorkItemKey** — the API and web surfaces' public, reversible transport
  identity for a WorkItem; a wrapper around the internal `WorkItemId`, not a
  separately minted identity.
- **Capability availability** — whether a given command or route is present
  on the composed `ApiApplications`/`WakeCliApplications` facade for the
  current runtime; an absent capability is a conflict, not a missing route.
- **Idempotency key** — an opaque, caller-supplied string every
  state-changing API command carries so a retried request does not
  double-apply.

## Core policies, invariants, and behaviours

- A surface MUST reach domain state only by calling a public application or
  view already composed by Bootstrap; it MUST NOT construct or reconstruct a
  domain event, aggregate, or store record itself.
- A response describing more than one domain (for example a WorkItem's
  detail alongside its resources, orchestration, execution, and activity
  data) MUST nest each domain's data under its own key rather than
  flattening fields from different domains into one object.
- A rejected request MUST be surfaced as an explicit validation failure
  (malformed input) or a conflict (the request is well-formed but cannot be
  applied as given, including an unavailable capability) — never a silently
  swallowed error.
- A command or route capability the current runtime's composed facade does
  not implement MUST be reported as a conflict, distinguishing "operator
  hasn't enabled this" from "does not exist."
- A value that looks like a secret (matching a name such as `token`,
  `secret`, `password`, `credential`, or `key`) MUST be redacted before
  configuration data or process log output leaves the process.
- `WorkItemKey` MUST be recoverable to exactly the `WorkItemId` it was built
  from; a value that fails to decode MUST be rejected, never silently mapped
  to a default identity.

## Conceptual schema

**Response envelope**

| Field | Type | Description |
| --- | --- | --- |
| `data` | domain view (per endpoint) | The single resource being returned. |
| `meta.asOf` | UTC instant | When the returned data was known to be current. |
| `meta.position` | integer, optional | Journal position the data reflects, when the endpoint tracks one. |

**Collection envelope**

| Field | Type | Description |
| --- | --- | --- |
| `items` | list of domain view (per endpoint) | The page's items, already truncated to the requested limit. |
| `page.nextCursor` | opaque cursor string or null | Pass back as `cursor` to continue; null when there is no further page. |
| `page.hasMore` | boolean | Whether a further page exists beyond `items`. |
| `page.total` | integer, optional | Total item count across all pages, when the endpoint can report it cheaply. |
| `meta` | Response envelope's `meta` | Same freshness metadata as a single-resource response. |

**Problem response**

| Field | Type | Description |
| --- | --- | --- |
| `type` | URI | A stable identifier for the failure category, keyed off HTTP status. |
| `title` | string | Human-readable failure name (e.g. `Conflict`, `Unprocessable Content`). |
| `status` | HTTP status code | Repeats the transport status for clients that only inspect the body. |
| `detail` | string, optional | Human-readable explanation of this specific failure. |
| `code` | closed vocabulary, optional | A machine-comparable failure code (e.g. `invalid-query`, `command-unavailable`). |
| `retryable` | boolean, optional | Whether retrying the same request could succeed without caller changes. |
| `current` | domain view, optional | The current state that caused a conflict, when available. |
| `violations` | list of `{path, message}`, optional | Field-level validation failures. |

**WorkItemKey**

| Field | Type | Description |
| --- | --- | --- |
| `workItemKey` | reversible transport identity | A `wk_`-prefixed, base64url encoding of a `WorkItemId`; carries no independent identity of its own. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [API application](api/api-application.spec.md) | surface application | HTTP query/command routing, request validation, response/page shaping, presentation of domain views into API response contracts | Calls the `ApiApplications` facade Bootstrap composes; its output is handed to the HTTP transport adapter for wire delivery. |
| [HTTP transport](api/http-transport.spec.md) | adapter | Node HTTP binding, JSON/problem+json encoding, static web asset serving and SPA fallback | Wraps the API application's dispatch result (or a static asset) as an actual HTTP response; owns nothing about what a route means. |
| [CLI command surface](cli/cli-surface.spec.md) | surface application | Argument parsing into a typed `WakeCommand`, dispatch to the `WakeCliApplications` facade, JSON-line output, process log redaction | Calls the same kind of Bootstrap-composed facade as the API, over a process's argv/stdout instead of HTTP. |
| [Web API client](web/web-api-client.spec.md) | adapter | Browser-side request construction, response decoding/validation, cache-key and refresh-interval policy | Consumes the API application's HTTP contract exactly as an external caller would; decodes every response defensively rather than trusting the wire shape. |

## Dependencies and system role

- Kernel — supplies the closed-vocabulary helper (`defineClosedVocabulary`/
  `ValueOf`) Surfaces uses for its own transport-level vocabularies (board
  condition, command status, browser route outcome).
- Work, Resources, Activities, Orchestration, Execution, Control-plane,
  Integrations (each depended on by Surfaces) — every route, presenter, CLI
  command, and web decoder ultimately reads or writes through one of these
  modules' public applications or views; Surfaces holds no data of its own
  beyond transport-shape translation.
- Bootstrap (depends on Surfaces) — composes the concrete `ApiApplications`
  and `WakeCliApplications` facades from every domain module's public
  application and supplies them to Surfaces at process start; Surfaces never
  composes these facades or imports a concrete adapter itself.
- Operators and external tooling (depend on Surfaces) — the CLI, HTTP API,
  and packaged web UI are the only supported ways to observe or command a
  running Wake instance.

## Decisions, exclusions, and deferred capability

- Authorization is anticipated by this module's ownership statement but not
  yet exercised: no surface currently checks caller identity or permission
  before executing a well-formed request. Every accepted command runs
  unconditionally once validation passes.
- The CLI command parser recognizes `tick`, `start`, `stop`, `api`, `ui`, `audit`, `correlate`, `validate-state`, `init`, `doctor`, `sandbox`, `sandbox-setup`, `sandbox-entrypoint`, `self-update`, and `smoke`. `init` creates its root before Bootstrap composes it. The other operational commands route through a Bootstrap-owned operational Surface port.
- The web client and API share no runtime code; the web client decodes every
  response field defensively (an unknown or missing field throws) rather
  than trusting that the API and web packages were deployed from the same
  build.
- `board` and `status` capabilities on `ApiApplications` are optional; a
  runtime that does not compose them reports the corresponding route as
  unavailable rather than omitting it from routing.

## Task 27B synchronization (2026-08-02)

The public control-plane command is `tick` at `/control-plane/commands/tick`; it returns the bounded full-pipeline result rather than invoking bare advancement. The web client uses the same operation.

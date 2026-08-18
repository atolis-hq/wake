# Web API Client — Component Specification

## Type, purpose, and scope

Adapter. The web API client is the packaged web UI's only path to Wake's
HTTP API: it constructs every request (query strings, JSON command bodies,
idempotency keys) and decodes every response defensively, so the rest of the
UI works against typed values rather than raw JSON.

## Ubiquitous language

- **Decoder** — a function that turns an unknown JSON value into a typed
  value, or throws identifying exactly which field failed to decode.
- **API problem** — this component's exception type wrapping a decoded
  problem response, thrown for any non-2xx response.
- **Refresh policy** — the fixed polling interval (or `false` for "never
  auto-refresh") assigned per data family.
- **Query key** — the cache key family a query result is stored and
  invalidated under.

## Responsibilities and boundaries

Owns:

- Building each request's path, query string, and (for commands) JSON body.
- Decoding every response body field by field rather than trusting its
  declared shape.
- Translating a non-2xx response into a thrown API problem, falling back to
  a generic problem when the error body itself doesn't decode.
- The polling interval assigned to each data family, and the query
  cache-key shape those families are stored under.

Does not own:

- Retry policy beyond what the caller's data-fetching layer applies on top
  of this component's thrown errors and refresh intervals.
- How a UI component renders a decoded value.
- The API's own validation or authorization — this component never
  second-guesses a 2xx response's business meaning, only its shape.

## Core policies, invariants, and behaviours

- Every response body MUST be decoded field by field; a missing or
  wrong-typed field MUST throw rather than silently substitute a default or
  pass an unvalidated value through.
- A non-2xx response MUST be surfaced as a thrown API problem; if the error
  body itself fails to decode as a problem response, this component MUST
  still throw a generic problem carrying the HTTP status, rather than let
  the decode failure escape as an unrelated error.
- A query string parameter MUST be omitted entirely when its value is
  undefined or the empty string, rather than sent as an empty parameter.
- A command request MUST always send exactly `{ idempotencyKey }` as its
  JSON body, mirroring the API's own single-field command validation.
- Closed-vocabulary values received from the API (command status, a run's
  `active` field, a board card's stage field) MUST be compared against the
  same shared `transport-values.ts` constants the API side constructs them
  from, never a locally redeclared string literal.
- Each data family MUST be assigned a fixed refresh interval, or explicitly
  `false` for none. A run list's own refresh interval MUST switch to the
  faster "active" interval whenever at least one returned run is still
  active, and fall back to the slower "historical" interval otherwise.

## Conceptual schema

**Refresh policy**

| Field | Type | Description |
| --- | --- | --- |
| family | closed vocabulary: `status` / `board` / `openWork` / `activeRuns` / `events` / `historicalRuns` / `health` / `runners` / `observability` / `configuration` / `commands` | The data family the interval applies to. |
| intervalMs | integer milliseconds, or `false` | Poll interval; `false` means never auto-refresh. |

**API problem**

| Field | Type | Description |
| --- | --- | --- |
| `problem` | Problem response (see the module page) | The decoded (or generic-fallback) problem body the failed request produced. |

## Dependencies and system role

- [API application](../api/api-application.spec.md) / [HTTP transport](../api/http-transport.spec.md)
  (depended on) — this component's entire contract is that boundary's
  response and problem shapes; a breaking change there breaks this
  component's decoders.
- Packaged web UI (depends on this component) — every UI data access goes
  through this client rather than calling `fetch` directly.
- `transport-values.ts` (owned by the API application) — the shared
  closed-vocabulary constants this component compares against instead of
  literal strings.

## Decisions, exclusions, and deferred capability

- This component performs no request retries or backoff itself; that is
  left to whatever calls it (e.g. a query-caching layer), using the refresh
  intervals and thrown API problems it produces.
- `status.get`'s decoder currently accepts its `conditionCounts` value via
  an untyped cast rather than a field-by-field decode, unlike every other
  decoder in this component.

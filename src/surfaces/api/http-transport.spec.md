# HTTP Transport — Component Specification

## Type, purpose, and scope

Adapter. HTTP transport translates between Node's raw HTTP request/response
objects and this surface's application-level contracts: it parses a request
into the method/path/body triple the [API application](api-application.spec.md)
expects, serves packaged web assets (with SPA fallback) when no API route
matches, and encodes every outcome — success, static asset, or failure — onto
the wire with the correct status, content type, and headers.

## Ubiquitous language

- **SPA fallback** — serving `/index.html` for a `GET`/`HEAD` request that is
  not under `/api/` and does not look like a static file request, so
  client-side routing works on a hard page load.
- **Browser route outcome** — this component's own closed vocabulary (`Spa`
  / `NotFound`) for whether a non-API, non-asset `GET` should fall back to
  the SPA shell.
- **Surface asset** — a servable static file (body, content type, headers)
  supplied by an `AssetSource`.

## Responsibilities and boundaries

Owns:

- Reading and parsing the request body as JSON, treating an empty body as
  absent for `GET`/`HEAD`.
- Constructing the method/path/body input handed to the API application's
  dispatcher.
- Falling back to static asset serving, and then SPA shell fallback, when
  the dispatcher declines a request.
- Encoding every response (JSON, problem+json, static asset, or plain-text
  404) with correct headers, including for `HEAD` requests (headers only, no
  body).
- Catching any error the dispatcher or its dependencies throw and turning it
  into a well-formed problem response rather than letting the process crash
  or leak an internal error message to the client.

Does not own:

- Which path maps to which domain call — that is the API application.
- What an asset actually contains — that is the `AssetSource` implementation
  supplied by Bootstrap/packaging.
- Request authorization.

## Core policies, invariants, and behaviours

- A request path starting with `/api/` MUST always receive a JSON or
  problem+json response from the API application's dispatcher, never asset
  or SPA fallback content.
- For a non-API path, a `GET`/`HEAD` request MUST first try to serve a
  matching static asset; if none exists and the path does not look like a
  filename (no `name.ext` suffix), the response MUST fall back to serving
  `/index.html` as the SPA shell. Any other method, or a path that looks
  like a missing static asset, MUST fall back to a plain-text 404.
- A `HEAD` request MUST receive the same status and headers as the
  equivalent `GET` would, with no response body.
- Malformed JSON in a request body MUST produce a 400 problem response with
  code `malformed-json`. An error shaped like an upstream HTTP client
  failure (any thrown value with a numeric `status` field ≥ 400 — e.g. an
  octokit `RequestError` from a rate-limited or unreachable GitHub call)
  MUST produce a 502 problem response with code `upstream-provider-error`,
  distinguishing an external provider outage from a genuine Wake bug. Any
  other unexpected error during dispatch MUST produce a generic 500 problem
  response. Neither the 502 nor the 500 case exposes the underlying error's
  message or stack.
- An immutable-looking static asset filename (a hashed/fingerprinted `.js`
  or `.css` name) MUST be served with a one-year immutable cache-control
  header; every other asset MUST be served with `no-cache`.
- Problem responses MUST be served as `application/problem+json`; every
  other JSON response MUST be served as `application/json; charset=utf-8`.

## Conceptual schema

This component constructs the module page's Problem response schema; it
additionally owns:

**Surface asset**

| Field | Type | Description |
| --- | --- | --- |
| `body` | byte stream | The static file's raw contents. |
| `contentType` | string | MIME type derived from the file extension, or a generic binary default. |
| `headers` | map of string to string | Response headers; always includes a cache-control directive. |

## Dependencies and system role

- [API application](api-application.spec.md) — supplies the dispatcher this
  component drives; the API application in turn depends on this component's
  shared `ApiDispatcher`/`ApiHttpResponse` contract to know the shape it
  must produce.
- `AssetSource` (Bootstrap/packaging-supplied) — the actual store of
  packaged web UI files; this component only decides routing and caching
  policy around it, never how the files got there.
- Node's `http` module — the underlying TCP/HTTP protocol implementation
  this component binds to.
- [CLI command surface](../cli/cli-surface.spec.md) (depends on this
  component) — the `api` and `ui` commands both start this transport, just
  against differently composed applications/assets.

## Decisions, exclusions, and deferred capability

- There is no HTTPS/TLS termination at this layer; this component only
  expects to run behind or in front of standard HTTP.
- Compression (gzip/brotli) is not applied by this component.

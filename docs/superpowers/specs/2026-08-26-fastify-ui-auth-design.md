# Fastify UI Authentication Design

## Goal

Make the control-plane UI safe to expose through its configured public URL.
An operator authenticates with a locally generated access key, and no
operational API data or commands are available without a valid session.

## Approach

Replace the bespoke `node:http` transport with a Fastify transport. Fastify
owns HTTP lifecycle, route registration, JSON parsing limits, error handling,
and static asset delivery. `@fastify/secure-session` owns the encrypted,
tamper-resistant session cookie; Wake does not implement cookie signing or
validation.

Bootstrap creates the mandatory auth configuration before starting either
`wake api` or `wake ui`. The server constructor requires it, so a production
composition cannot accidentally omit authentication.

## Route policy

The routes are registered in explicit scopes:

| Scope | Routes | Policy |
| --- | --- | --- |
| Login | `POST /api/v1/auth/login`, `GET /api/v1/auth/session` | Public; login has a small, explicit body limit and rate limiting. |
| Protected API | Existing operational `/api/v1/**` routes | A Fastify `onRequest` hook rejects an absent or invalid session before body parsing. |
| Web assets | UI bundle and SPA fallback | Public only so the login screen can load; the browser receives no operational data until its authenticated API calls succeed. |
| Health | Only if required by container/orchestration health checks | Explicitly public, minimal, and non-sensitive. |

This structure means new operational endpoints are protected by their plugin
scope. Any intentional anonymous endpoint must be declared in the public
scope and covered by a test.

## Credentials and CLI

Wake stores an operator access key and session secret under `.wake/auth/` with
owner-only permissions where the platform supports them. `wake ui token`
prints the current access key; `wake ui token set <key>` rotates it while
preserving unrelated durable state. Token rotation invalidates sessions by
rotating the Fastify session key as well.

The web app presents a login view until `GET /api/v1/auth/session` confirms a
session. It submits the access key only to the local-origin login route and
never persists it in browser storage.

## Error handling and limits

The server defines a conservative global body limit and a smaller login limit.
It returns the existing API problem format for malformed bodies, request-size
rejection, and unexpected failures. Authentication failures return 401 without
revealing whether an access key is valid. Login attempts are rate-limited;
successful login clears the attempt state.

## Tests and verification

Tests cover unauthenticated API denial before body parsing, valid login and
session use, invalid/expired sessions, access-key rotation/session
invalidation, route-scope enforcement, static SPA delivery, CLI token output
and replacement, and the web login state. Existing API-domain and browser
fixtures move to Fastify injection or an ephemeral localhost listener.

Before merging, run focused surface and web tests, `npm run verify`, the
relevant integration suite, then build and publish the `wake-dev` sandbox from
`C:\Users\live\wake-home`. Verify a real unauthenticated request receives 401,
obtain a token with the CLI, log in through the published UI, and confirm an
authenticated operational request succeeds.

# UI Auth Opt-out and Pairing Design

## Purpose

Wake's UI/API remains authenticated by default while allowing an explicit local
development opt-out. Operators can start a browser session from another device
without revealing the durable UI access key in a URL, terminal output, browser
history, or QR code.

## Configuration

Add `surfaces.web.auth.disabled` to the strict root configuration schema. It is
optional and defaults to `false`. When `true`, the UI and operational API run
without the session guard and the login UI is not rendered. This is an explicit
opt-out for local development; it must never be inferred from loopback binding
or a missing credential file.

The setting applies to both `wake ui` and the web host started by `wake start`.
The CLI reports that UI authentication is disabled instead of minting a login
grant.

## Credentials and pairing grants

The durable access key remains private in `.wake/auth/credentials.json` and is
used only to mint a pairing grant. `wake ui token` no longer prints that key.
It creates a random, single-use grant that expires after ten minutes. The
credential store persists a bounded list of grants, each represented only by a
hash, expiration time, and consumed status. The plaintext grant is emitted once
by the CLI and is not persisted.

The CLI prints:

- a localhost login URL;
- a configured public URL when one is available;
- matching QR codes containing the URL plus grant, and a short explanation that
  the link is single-use and expires in ten minutes.

The browser redeems `?grant=` by POSTing the value to a public pairing endpoint.
The server atomically verifies and consumes it, writes the normal encrypted
session cookie, then the browser replaces the URL to remove the query string.
The query string is unavoidable for QR handoff but contains only the short-lived
single-use grant. The login page sets a restrictive referrer policy and does not
load third-party resources.

Manual token entry accepts a pairing grant, not the durable access key.

## Login page

The unauthenticated page uses Wake's existing logo and typography in a
responsive two-column layout: a branded left panel and focused login card on the
right. On narrow screens it becomes a single column. The heading is `Login`.
Inputs, primary action, spacing, error treatment, and font choices use the
existing Wake web component/style conventions.

## Safety and failure behavior

- Pairing grants are one-time and expire after ten minutes.
- Invalid, expired, or consumed grants return 401 without identifying which
  condition occurred.
- Redeeming a grant creates a normal one-day session but does not disclose the
  durable credential to the browser.
- Login and redeem endpoints retain request-size and rate limits.
- Disabled auth has no credential generation, login routes, or pairing routes.

## Verification

Tests cover config default/opt-out, durable-key isolation, grant expiration and
single use, session issuance, CLI text/QR URLs, query-string URL cleanup, and
desktop/mobile login layout. Local sandbox validation covers the enabled and
disabled states.

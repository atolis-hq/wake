# Closed issue projection sync

## Goal

Ensure a GitHub issue that is closed after Wake has projected it is reflected as
`closed` in the local projection on the next successful poll.

## Design

The GitHub client will request issues with `state: 'all'` rather than only
open issues. The existing polling and `ticket.upsert` normalization path will
therefore receive a closed issue and update its projection without a second
sync mechanism or per-item API requests.

## Behaviour

- Open issues continue to be discovered and processed exactly as today.
- Closed issues are emitted as normal `ticket.upsert` events when their
  `updated_at` value differs from the stored projection.
- The existing projection updater records the normalized `closed` state.

## Test coverage

Add a regression test proving that a closed GitHub issue is normalized into a
`ticket.upsert` whose ticket state is `closed`, and update the client test to
assert the `state: 'all'` API argument.

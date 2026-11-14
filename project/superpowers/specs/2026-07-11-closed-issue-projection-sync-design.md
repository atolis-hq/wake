# Closed issue projection sync

## Goal

Ensure a GitHub issue that is closed after Wake has projected it is reflected as
`closed` in the local projection on the next successful poll.

## Design

The GitHub client requests issues with `state: 'all'` rather than only open
issues. After the first successful poll, each request includes a `since` value
one hour before the previous successful-poll timestamp. The existing polling
and `ticket.upsert` normalization path therefore receives a closed issue and
updates its projection without a second sync mechanism or per-item API
requests.

## Behaviour

- Open issues continue to be discovered and processed exactly as today.
- The first poll has no time filter; later polls re-fetch the previous hour to
  make the timestamp boundary tolerant of delayed provider updates.
- Closed issues are emitted as normal `ticket.upsert` events when their
  `updated_at` value differs from the stored projection.
- The existing projection updater records the normalized `closed` state.

## Test coverage

Add regression tests for the `state: 'all'` request, its optional `since`
argument, and the one-hour overlap calculated from the stored poll watermark.

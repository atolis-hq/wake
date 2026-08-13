# Board frozen indicator

## Goal

Make a frozen work item immediately identifiable on the board with the existing
durable `frozen` work-item state as the source of truth.

## Design

The board card response will include an optional `frozen` boolean. The board
card will render a cold-blue `StatusBadge` when that value is `true`, alongside
the existing card metadata. The badge contains a snowflake icon and the visible
text `frozen`; its tooltip explains that automatic progress is paused.

Cards without `frozen: true` retain their current appearance and metadata.

## Data flow

The board projection already derives each card from the work-item projection.
It will carry the work item’s durable `frozen` flag into the board card, which
the API contract and web decoder deliver to `BoardCard`.

## Verification

The board API/projection coverage will assert that frozen work items expose the
flag. The existing board component test will use a frozen fixture and assert the
badge label and tooltip; it will also prove that a non-frozen card has no badge.
This is a lightweight render-level UI test with no browser automation.

# GitHub Review Body Intake Design

## Goal

Preserve general GitHub pull-request review bodies as Wake feedback while retaining
the existing approval and changes-requested workflow signals.

## Approach

The GitHub source will emit a feedback observation for every submitted review
with non-empty text, including reviews in the `COMMENTED` state. Its payload body
is the text GitHub supplied, so the comment-history reader includes it in the
runner prompt.

For `APPROVED` and `CHANGES_REQUESTED`, the source will continue emitting its
separate command observation (`/accepted` or `/changes`). This preserves the
existing inbound command and watch-gate behavior. Empty reviews therefore still
emit their state signal but add no empty feedback observation.

## Data Flow

`listReviews` returns a review -> `githubReviewObservation` produces zero or one
feedback draft plus zero or one state-signal draft -> the event journal records
the drafts -> the comment-history reader returns the feedback body to the runner.

Distinct, deterministic event IDs will identify the feedback and command drafts
for the same review. Re-polls remain journal-idempotent.

## Testing

Unit coverage will assert that a `COMMENTED` review with text produces one formal
feedback event containing the review body, and that an approved review with text
produces both the feedback event and the existing `/accepted` command event.

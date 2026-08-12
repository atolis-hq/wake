# Mobile event card design

## Scope

Adjust the shared event card used by both the Events page and the work-item Events tab on mobile viewports.

## Layout

At the existing mobile breakpoint, an event card button uses two grid rows:

- The first row contains the event timestamp and the expand/collapse chevron.
- The second row contains the event type, spanning the available card width.
- The event ID remains hidden on mobile.

The event type has a zero minimum width, remains on one line, and truncates with an ellipsis when it exceeds the panel width. It must not wrap at character boundaries. Desktop layout is unchanged.

## Verification

Add a focused web UI test covering the shared event row's responsive class contract, then run that test and build the web surface.

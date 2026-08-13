# Work Detail Overview Layout Design

## Scope

Reorganise the `src-next` web work-item detail page's Overview tab. The Events
tab remains unchanged.

## Layout

The work-item title is followed immediately by the Overview/Events tab
navigation. The tab bar has no filled background.

The Overview content is a responsive two-column grid. Its sidebar is first in
document order, but appears in the right column on wider screens and above the
runs on narrow screens.

The sidebar contains, in order:

1. Freeze/unfreeze and delete controls.
2. The existing work details panel, ordered Work identity, State, Workflow,
   then Stage.
3. Resources, with a smaller section heading.

The main column contains the Runs section and existing runs table/empty state.

## Resource cards

Resource cards retain their title, locator label where it is distinct from the
title, capabilities, and external link. They no longer show the trailing
resource revision/identifier.

## Verification

Add or update a focused web UI test that verifies the Overview structure and
resource-card display, then run the relevant test suite and the web typecheck
or build.

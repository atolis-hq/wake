# Blocked `/changes` Resume Design

## Goal

A human `/changes` issue comment restarts the current agent stage only when that
stage ended with the otherwise-unroutable `blocked` agent outcome.

## Design

The GitHub inbound translator retains its existing signal behaviour for
workflows that are waiting. For an issue `/changes` command that has no wait to
satisfy, it asks Orchestration to resume the correlated primary workflow.

Orchestration accepts that request only when the workflow is blocked because
the current agent stage produced an unconfigured `blocked` outcome. It records
the inbound comment's deterministic command identity with the existing
`orchestration.operator-retry-requested` fact, then requests the same stage at
the next activation ordinal. The recorded command identity makes repeated
delivery of one GitHub comment idempotent.

No UI retry affordance changes. Other blocked states, supplemental activities,
follow-on activities, non-agent activities, and `/approved` remain unchanged.

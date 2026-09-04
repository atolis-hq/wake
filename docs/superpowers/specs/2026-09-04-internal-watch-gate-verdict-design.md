# Internal Watch-Gate Verdict Design

## Goal

Resume a parent workflow from a completed watch child using Wake's durable
orchestration facts, without publishing to or re-ingesting from GitHub.

## Design

Child completion reconciliation already runs immediately after every accepted
activity outcome. It records `orchestration.child-completed` and then creates
a signal for the waiting parent. For a parent using an ordinary explicit child
completion wait, this remains the existing `orchestration.child-completed`
signal.

For a parent waiting on `orchestration.watch-gate-verdict`, reconciliation
instead creates that signal directly. Its authority and evidence remain the
completed child's watch and workflow-instance id. Its outcome is the child's
durable terminal activity outcome. `done` follows the configured resume target;
`rejected` follows the configured reject-resume target. Unsupported child
outcomes remain unconsumed, as they do today when no compatible wait exists.

GitHub agent-run reports stay as outbound operator-facing publication. Their
embedded verdict marker is no longer required for a watch child to advance its
parent, eliminating the publication -> polling -> inbound translation loop.

## Safety and tests

The parent records `orchestration.child-completion-consumed` atomically with
the accepted signal, so replay remains idempotent. A regression E2E scenario
will complete a rejected review child and assert that the parent immediately
re-requests `implement`, without an external comment or inbound event.

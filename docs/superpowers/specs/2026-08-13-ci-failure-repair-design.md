# CI failure repair design

## Goal

Allow a workflow watch to start a bounded repair workflow only when a correlated
pull request's observed checks change to `failing`.

## Design

Watches gain an optional `where` clause on an event trigger. The only supported
predicate in this change is `checks: failing`, and it is valid only for the
`pr.checks-changed` event. The orchestration service evaluates the predicate
against the decoded event payload before returning a watch match.

The GitHub agent context gains the current pull-request check state and the
individual check-run/status evidence. Agent prompts append that information in
the existing untrusted context block, so a `ci-fix` prompt can identify a
failing check and follow its URL without treating provider data as instructions.

The workflow reference documents a bounded `ci-fix` watch and repair workflow.
Wake-home configuration will be updated separately to opt `default` and
`dark-factory` into the documented pattern.

## Error handling and limits

Only `failing` is accepted as a predicate value. Unsupported predicate/event
combinations fail configuration compilation. The existing `maxPerGroup` claim
remains the circuit breaker for repeated failures. A missing or unavailable
provider check record is represented as `unknown`, and cannot match this
failure-only watch.

## Verification

Unit and integration tests prove that passing/pending check changes do not
match, failing changes do match, and the rendered agent prompt contains the
current check evidence. Documentation contains a complete configuration
example. The pre-change unit baseline has two unrelated version-resolution
test failures, which will be re-run and reported separately.

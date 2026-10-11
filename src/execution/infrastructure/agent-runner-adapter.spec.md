# Agent run response translation — Component Specification

## Type, purpose, and scope

Adapter. This component parses the raw `output` (and `failure`, when
present) an agent-kind runner's `AgentRunnerResult` reports into Execution's
own structured `AgentRunResponse` — a sentinel outcome, human-readable
display text, any reported artifacts, and flattened diagnostic metadata —
before that result is recorded onto a Run.

## Ubiquitous language

See the module specification for Agent run response and Transport status.
This component recognizes a structured JSON result or a plain-text status
marker such as `[[STATUS: DONE]]`. The Activity owns status translation;
Execution uses that shared contract to build its display response.

## Responsibilities and boundaries

This component owns turning one `AgentRunnerResult` into one
`AgentRunResponse`. It does not decide an Activity's own outcome — the
agent Activity handler translates the same raw output using the shared
status contract for its `ActivityOutcome` recorded via `RunSucceeded`. It
does not read or write any event itself; the Execution service calls it and
appends the result.

## Core policies, invariants, and behaviours

- When the reported transport is not `succeeded`, the outcome MUST be
  `FAILED` regardless of the raw output's content; `displayBody` MUST be
  the failure's own `message` when present, falling back to whatever the
  output-parsing rules below would have produced, and finally to a fixed
  "Runner failed without a response." message when both are empty.
- When transport is `succeeded`, Execution MUST use Activity's shared result
  translation. Structured JSON is parsed first; its recognized status and
  non-blank string `displayBody` are preserved. Otherwise a fixed
  outcome-specific display sentence is used for recognized JSON results.
- Plain text MUST contain a `[[STATUS: <STATUS>]]` marker. The last marker
  anywhere in output is authoritative, including when followed by prose.
  Recognized statuses are `DONE`, `REJECTED`, `BLOCKED`,
  `NEEDS_CLARIFICATION`, and `FAILED`. Display text MUST retain prose and
  artifact fences while removing status markers and trimming surrounding space.
- Missing markers, unknown last markers, legacy bare or bold status lines,
  and status tokens appended to prose MUST produce `FAILED`, matching the
  Activity's `invalid-agent-result` outcome. A fenced `wake-result` JSON
  block alone is plain text without a marker and MUST NOT supply a status.
- An unverified completion on successful transport MUST still produce
  `BLOCKED` with the supplied completion reason as display text.
- `metadata` MUST always include the reporting runner's own `runner` name,
  and MUST additionally include `model` and `sessionId` when the raw result
  reported them, and `inputTokens`/`outputTokens`/`cacheReadTokens`/
  `cacheWriteTokens`/`costUsd` (individually, only the ones reported) when
  the raw result carried token usage.
- `artifacts` is never populated by this component's parse: every
  `AgentRunResponse` it returns has `artifacts` absent, even though the
  type permits a list — the field exists on the contract but nothing here
  currently derives one from the raw output.

## Conceptual schema

See the module specification's Agent run response table for
`AgentRunResponse`'s fields. This component adds no durable schema of its
own; it is a pure function from one `AgentRunnerResult` to one
`AgentRunResponse`.

## Dependencies and system role

- Runner adapters (depends on) — supplies the `AgentRunnerResult` this
  component parses; unaffected by, and unaware of, this component's own
  translation.
- Execution service (depends on this component) — the only caller, invoked
  once per reported runner result immediately before appending
  `RunRunnerResultReported`.
- Surfaces and Integrations (indirectly depend on this component, via
  `RunView.agent`) — read the parsed outcome, display text, and metadata
  instead of re-parsing a runner's raw output themselves; `agentTokenUsage()`
  (in the Runner adapters' own contracts) recovers a token-usage summary
  from `metadata`.

## Decisions, exclusions, and deferred capability

- Execution owns display text and metadata; Activities own status translation.
  Both use the same marker and structured JSON rules, so publication and
  workflow routing agree for ordinary successful transport results.
- Recovery's `execution.run-recovered` fact never carries a parsed `agent`
  value: `RecoveredRunResult.result` records the raw `AgentRunnerResult` from
  the external-execution inspector unparsed, so a recovered Run's `agent`
  field stays absent even though its `outcome` (the Activity outcome) is
  set.

# Agent run response translation — Component Specification

## Type, purpose, and scope

Adapter. This component parses the raw `output` (and `failure`, when
present) an agent-kind runner's `AgentRunnerResult` reports into Execution's
own structured `AgentRunResponse` — a sentinel outcome, human-readable
display text, any reported artifacts, and flattened diagnostic metadata —
before that result is recorded onto a Run.

## Ubiquitous language

See the module specification for Agent run response and Transport status.
This component additionally defines the three raw-output conventions it
recognizes, in priority order: a **bare envelope** (the runner's entire
output is one JSON object with a `status` field), a **wake-result fence** (a
Markdown code fence whose opening line or first line is literally
`wake-result`, containing a JSON object with a `status` field), and a
**sentinel line** (the output's last non-empty, non-fence line is itself one
of the five outcome words, optionally wrapped in Markdown bold).

## Responsibilities and boundaries

This component owns turning one `AgentRunnerResult` into one
`AgentRunResponse`. It does not decide an Activity's own outcome — the
agent Activity handler parses the same raw output independently, for its
own `ActivityOutcome` recorded via `RunSucceeded`, and the two parses are
not guaranteed to agree since the underlying rules are not identical. It
does not read or write any event itself; the Execution service calls it and
appends the result.

## Core policies, invariants, and behaviours

- When the reported transport is not `succeeded`, the outcome MUST be
  `FAILED` regardless of the raw output's content; `displayBody` MUST be
  the failure's own `message` when present, falling back to whatever the
  output-parsing rules below would have produced, and finally to a fixed
  "Runner failed without a response." message when both are empty.
- When the transport is `succeeded`, the output MUST be parsed by trying
  each convention in order and using the first that matches:
  1. **Bare envelope** — the entire trimmed output parses as JSON with a
     `status` field naming one of `DONE`/`REJECTED`/`BLOCKED`/`NEEDS_CLARIFICATION`/`FAILED`.
     When that envelope supplies a non-blank string `displayBody`, it MUST
     be retained verbatim. Otherwise `displayBody` MUST be a fixed,
     outcome-specific sentence (there is no other text to show once the
     whole output was the envelope).
  2. **Wake-result fence** — the *last* fenced code block in the output
     whose fence is tagged `wake-result` contains, after stripping a
     trailing bare sentinel-word line, JSON with a recognized `status`.
     `displayBody` MUST be the output preceding that fence, trimmed,
     falling back to the same fixed sentence when that prefix is empty. A
     fence present but not parseable as a recognized envelope MUST fall
     through to the next rule rather than fail.
  3. **Sentinel line** — the last non-empty, non-fence-marker line of the
     output, with a wrapping `**`/`__` Markdown bold stripped, is itself
     one of the five outcome words. `displayBody` MUST be the output with
     that one matched line removed, trimmed.
  4. **No convention matched** — the outcome MUST be `FAILED` when the
     trimmed output is empty, otherwise `BLOCKED`; `displayBody` MUST be
     the raw trimmed output.
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

- This component's parse and the agent Activity handler's own parse of the
  same raw output are two independent implementations of similar but not
  identical rules; a raw output that one accepts and the other rejects (or
  interprets differently) is not reconciled — `RunView.agent.outcome` and
  `RunView.outcome` can disagree for the same Run.
- Recovery's `execution.run-recovered` fact never carries a parsed `agent`
  value: `RecoveredRunResult.result` records the raw `AgentRunnerResult` from
  the external-execution inspector unparsed, so a recovered Run's `agent`
  field stays absent even though its `outcome` (the Activity outcome) is
  set.

# Generic agent session resume design

**Status:** Approved

## Decision

Wake will durably reuse an agent session only for a later attempt of the same
Execution activation and the same configured runner adapter kind. Execution
passes the prior opaque session identifier to the selected adapter; it neither
parses, validates, nor exposes vendor session state. The agent Activity always
constructs its normal, current prompt before that hand-off, so both resumed and
fresh invocations receive the complete current context.

The activation identity is intentionally the resume boundary. It represents
one workflow action and its retries. A different activation, including a later
workflow stage, starts a new session even when it has the same Work Item or
runner pool. This preserves legacy's action isolation without inventing a
cross-stage conversation policy.

## Durable hand-off

`RunRunnerResultReported.agent.metadata.sessionId` is already the durable,
generic representation of a successful runner session. Before starting a new
attempt, Execution examines prior Runs for the current activation from newest
attempt to oldest. It selects the first non-empty session ID whose persisted
`RunStarted.runner.cli` equals the newly resolved runner's configured adapter
kind. It makes that string available to the Agent Activity as
`resumeSessionId`, which forwards it unchanged in `RunnerRequest`.

No vendor-private result object, raw CLI event, provider class, or telemetry
leaves a runner adapter. The existing generic result fields remain the only
cross-layer values:

| Value | Cross-layer form | Ownership |
| --- | --- | --- |
| resumable conversation | opaque `sessionId: string` | adapter extracts; Execution persists/selects |
| model usage | generic input/output/cache token counters and optional USD cost | adapter extracts; Execution records generic metadata |
| agent response | output text and normal Wake result envelope | adapter returns; Agent Activity translates |

Execution must not persist a session ID when the adapter did not report one,
must not pass a session from a different adapter kind, and must not make a
session ID a workflow input or public configuration value. There is no new
configuration.

## Adapter policy

Each concrete vendor adapter owns its own CLI argument shape and stdout
parsing. It receives an optional generic `resumeSessionId` and must use its
vendor-supported resume invocation when present. It must still supply the
full newly-rendered Wake prompt/context to that invocation.

Wake does not detect an unavailable or expired session ID and does not start a
fresh session automatically after a resumed invocation fails. Resume failure
is an ordinary failed or ambiguous Run result, handled through Wake's normal
failure, retry, and escalation policy. Adapters must not classify free-form
stderr as an unavailable-session signal. The adapter must not surface raw
vendor payloads through `AgentRunnerResult` metadata.

An ordinary process failure, timeout, cancellation, ambiguous outcome, or
unrecognised error is *not* evidence that resume is unavailable. It must be
returned as the normal failed/ambiguous result; Wake must not replay an agent
request after an uncertain external effect.

Configured generic `command` and fake runners do not claim vendor resume
support. They receive no session ID behaviour beyond their existing request
contract, and they must not manufacture an ID. Claude, Codex, and Cursor
adapters parse only the minimum vendor output needed to return the generic
output/session/token fields; their JSON types and failure classifiers remain
private implementation details.

## Behavioural sequence

```text
prior Run reports opaque session ID S
        |
later attempt, same activation + same adapter kind
        |
Execution supplies S; Agent Activity renders current full context
        |
adapter attempts vendor resume(S, current prompt)
        |-- succeeds -> return parsed generic result (possibly new S')
        |-- any failed/unavailable resume -> return failure; no replay
        |-- any other failure -> return failure; no replay
```

## Required proof

Tests must prove durable selection only from the same activation and adapter
kind, current context forwarding, opaque generic persistence,
vendor-specific CLI resume arguments, parsed generic session/token outputs,
and no retry after any failed resume. They must also prove that a different
activation and a different adapter kind begin fresh. No test may assert
vendor-private raw JSON outside the corresponding adapter test.

# Agent Activity — Component Specification

## Type, purpose, and scope

Adapter. Agent Activity is the built-in `agent` Activity: it translates a
generic prompt/template invocation into a request against the
`AgentRunnerPort` Execution supplies, and translates that runner's transport
result back into one of the Activity's declared outcomes.

## Ubiquitous language

- **Runner transport status** — the closed-vocabulary status
  (`succeeded` / `failed` / `cancelled` / `ambiguous`) describing whether the
  underlying agent process or session itself completed, independent of what
  the agent produced.
- **Sentinel** — the agent's own structured result
  (`{ status: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED', ... }`), parsed
  from the runner's output text.
- **Template** — a named, externally rendered prompt (prompt text, optional
  model, allowed tools, and `maxTurns`) an invocation may reference instead
  of supplying a literal prompt.
- **Untrusted ticket context** — a `template` invocation's WorkItem title,
  body, and comments, resolved via an injected `AgentContextReader` and
  supplied to the renderer and the rendered prompt as data, never as
  instructions.
- **Runner context** — the `runnerName`, `activationOrdinal`, and `action`
  attached to a runner request so the runner can correlate its logs to the
  activation that caused it.

## Responsibilities and boundaries

Agent Activity owns building the runner request from invocation input (or a
rendered template); for a `template` invocation, resolving untrusted ticket
context and appending it to the rendered prompt as delimited data; attaching
runner context to the request when Execution supplies one; reporting the
runner's external-execution identity and final result back through the
execution context; and translating a transport result and sentinel into one
of the Activity's declared outcome kinds.

It does not start or supervise the runner process itself (the
`AgentRunnerPort` Execution resolves), render a named template's content
(the injected `AgentTemplateRenderer`; a referenced template with no
renderer configured fails execution with an error, not a guessed prompt),
or fetch a WorkItem's ticket data itself (the injected `AgentContextReader`;
it only shapes what that reader returns). It does not choose a model or
allowed-tools default beyond what invocation input or the template itself
supplies.

## Core policies, invariants, and behaviours

- Invocation input MUST specify exactly one of `prompt` or `template`, never
  both and never neither.
- If `template` is given and no `AgentTemplateRenderer` is configured,
  execution MUST fail with an error, not a `blocked`/`failed` outcome — this
  is a configuration error, not an agent-run result.
- `context.runner` MUST be present; if Execution did not resolve a runner,
  execution MUST fail with an error.
- An explicit `model`/`allowedTools` on invocation input MUST take
  precedence over the template's own values. `maxTurns` is taken only from
  the template, never from invocation input, and is omitted from the runner
  request entirely when the template does not declare one — it is never
  defaulted or clamped by this Activity.
- When the runner reports transport `ambiguous`, the outcome MUST be
  `blocked` with reason `ambiguous-runner-result` — an ambiguous transport
  result is treated as needing a human, not silently retried.
- When the runner reports any transport other than `succeeded` or
  `ambiguous`, the outcome MUST be `failed` with reason `runner-failed`,
  carrying the runner's own failure message when one was reported.
- When transport succeeded, the runner's output MUST be parsed as JSON; if
  parsing fails, the whole trimmed output text is treated as the sentinel's
  `status`.
- A parsed result without a string `status` field, or with a `status`
  outside `DONE`/`REJECTED`/`BLOCKED`/`FAILED`, MUST translate to a `failed`
  outcome with reason `invalid-agent-result`.
- A recognized `status` MUST translate to the outcome kind of the same name
  (`DONE`→`done`, `REJECTED`→`rejected`, `BLOCKED`→`blocked`,
  `FAILED`→`failed`), carrying the full parsed sentinel object as outcome
  data.
- The runner's external-execution identity (when the runner provides one)
  and its final result MUST be reported back through the execution context
  before the Activity returns, regardless of the translated outcome kind.
- Only a `template` invocation resolves untrusted ticket context and
  receives an untrusted-data block; a literal `prompt` invocation MUST NOT
  consult `AgentContextReader` and MUST NOT have such a block appended.
- For a `template` invocation, the renderer MUST receive `workItemId` plus
  the resolved `issueTitle`, `issueBody`, and `comments`, defaulting to `''`,
  `''`, and `[]` when no `AgentContextReader` is configured (resolution
  still happens; it isn't skipped).
- The rendered prompt MUST have the untrusted ticket context appended as a
  delimited `<wake-untrusted-data>` block of escaped JSON (`<`, `>`, `&` as
  Unicode escapes) preceded by an explicit notice that the data is not
  instructions.
- When Execution supplies `runnerContext` (`runnerName`, `activationOrdinal`)
  on the execution context, the runner request MUST include a `context`
  field carrying that pair plus an `action` equal to the template name, or
  `'prompt'` for a literal-prompt invocation; with no `runnerContext`
  supplied, the field MUST be omitted entirely.
- When Execution supplies an opaque `resumeSessionId`, this Activity MUST
  forward it unchanged with the freshly rendered complete request. It neither
  parses, validates, persists, nor exposes vendor-specific session details;
  the selected runner adapter decides its resume invocation.

## Conceptual schema

**Agent Activity input**

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | string (optional) | Literal prompt text; mutually exclusive with `template`. |
| `template` | string (optional) | Name of a template to render; mutually exclusive with `prompt`. |
| `model` | string (optional) | Overrides the template's model, if any. |
| `allowedTools` | list of string (optional) | Overrides the template's allowed tools, if any. |

**Agent Activity outcome data**

| Field | Type | Description |
| --- | --- | --- |
| `status` | closed vocabulary: `DONE`/`REJECTED`/`BLOCKED`/`FAILED` (recognized case only) | The agent's own reported sentinel, echoed into outcome data verbatim. |
| `reason` | closed vocabulary: `ambiguous-runner-result` / `invalid-agent-result` / `runner-failed` (failure cases only) | Why the Activity could not translate a recognized agent result. |
| `message` | string (optional) | The runner's own failure message, when `runner-failed` and one was reported. |
| `retrySafety` | closed-vocabulary value, agent-supplied (optional) | Free-form data in a recognized `FAILED` sentinel; Orchestration, not this Activity, interprets `requires-reconciliation` as disqualifying retry — see the module page. |

**Untrusted ticket context** (resolved per `template` invocation, not
durable)

| Field | Type | Description |
| --- | --- | --- |
| `issueTitle` | string | The WorkItem's ticket title; `''` when no `AgentContextReader` is configured. |
| `issueBody` | string | The WorkItem's ticket body; `''` when no `AgentContextReader` is configured. |
| `comments` | list of `{ author, occurredAt, body }` | Ticket comments in the reader's own order; `[]` when no reader is configured. |

## Dependencies and system role

- Execution (Agent Activity depends on it) — supplies the concrete
  `AgentRunnerPort`, the abort signal, the reporting callbacks, and an
  optional `runnerContext` (`runnerName`, `activationOrdinal`) this Activity
  forwards into the runner request; without a resolved runner, execution
  fails.
- `AgentTemplateRenderer` (injected, optional) — the source of a named
  template's prompt/model/allowedTools/maxTurns; not implemented here.
- `AgentContextReader` (injected, optional) — resolves a `template`
  invocation's WorkItem title, body, and comments for the untrusted-data
  block; not implemented here. Absent, the block carries empty values
  rather than being skipped.
- Activity Registry (depends on Agent Activity) — registers this as the
  built-in `agent` Activity.

## Decisions, exclusions, and deferred capability

- The Activity does not itself define or validate `retrySafety`; it is
  free-form data in a recognized `FAILED` sentinel that Orchestration's
  retry policy independently interprets.
- There is no cancellation or timeout policy owned here; the abort signal
  and any timeout are Execution's concern.
- The Activity does not sanitize ticket content beyond JSON-escaping
  `<`/`>`/`&`; guarding against prompt injection is a prompt convention
  (delimited, labeled-as-data block), not a content policy.

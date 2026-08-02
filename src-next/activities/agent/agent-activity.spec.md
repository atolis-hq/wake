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

## Responsibilities and boundaries

Agent Activity owns building the runner request from invocation input (or a
rendered template), reporting the runner's external-execution identity and
final result back through the execution context, and translating a
transport result and sentinel into one of the Activity's declared outcome
kinds.

It does not start or supervise the runner process itself — that is the
`AgentRunnerPort` implementation Execution resolves. It does not render a
named template's content — that is an injected `AgentTemplateRenderer`; if a
template is referenced but no renderer is configured, execution fails with
an error rather than guessing at prompt content. It does not choose a
model or allowed-tools default beyond what invocation input or the template
itself supplies.

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

## Dependencies and system role

- Execution (Agent Activity depends on it) — supplies the concrete
  `AgentRunnerPort`, the abort signal, and the reporting callbacks this
  Activity calls; without a resolved runner, execution fails.
- `AgentTemplateRenderer` (injected, optional) — the source of a named
  template's prompt/model/allowedTools/maxTurns; not implemented by this
  module.
- Activity Registry (depends on Agent Activity) — registers this as the
  built-in `agent` Activity.

## Decisions, exclusions, and deferred capability

- The Activity does not itself define or validate `retrySafety`; it is
  free-form data in a recognized `FAILED` sentinel that Orchestration's
  retry policy independently interprets.
- There is no cancellation or timeout policy owned here; the abort signal
  and any timeout are Execution's concern.

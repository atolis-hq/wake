# Runner pools naming design

## Decision

Replace the overloaded `tier` vocabulary with `runnerPool` vocabulary throughout
Wake's active configuration, domain contracts, runtime routing metadata, user
interfaces, documentation, templates, and tests.

The canonical public names are:

| Current name | Replacement | Meaning |
| --- | --- | --- |
| `tiers` | `runnerPools` | Named, ordered collections of runner keys. |
| `tier` | `runnerPool` | The pool selected by a route or recorded for a run. |
| `defaultTier` | `defaultRunnerPool` | Pool selected when a route does not name one. |
| tier name | runner-pool name | A free-form routing label such as `standard`, `review`, or `economy`. |

`RunnerPool` is the domain representation for one named pool. Its members are
keys from `execution.agentRunners`; they are not model identifiers. A member
therefore represents the full runner configuration, including its executable,
model, credentials, timeout, and provider-specific settings.

## Configuration shape

```yaml
execution:
  agentRunners:
    codex-standard:
      kind: codex-cli
      command: codex
      model: gpt-5.5
    claude-haiku:
      kind: claude-cli
      command: claude
      model: claude-haiku
  runnerPools:
    standard: [codex-standard, claude-haiku]
    review: [claude-haiku]
  defaultRunnerPool: standard

workflows:
  default:
    stages:
      implement:
        execution:
          runnerPool: standard
```

`agentRunners` remains unchanged. `runnerPools` deliberately does not become
`agentRunnerPools`: the enclosing `execution` object and its member keys make
the relationship clear without repeating the qualifier.

## Routing semantics

A runner pool is an ordered fallback set, not a capability level. Resolution
selects the first eligible configured runner. When the preferred runner is
ineligible (for example, quota-paused), resolution proceeds sideways through
the remaining members of that same pool. It must not infer an escalation path,
select another pool, or claim that pool labels have a global ordering.

Pool labels are free-form operational names. `light`, `standard`, and `deep`
remain legal labels, but the schema and language must not treat them as a
closed capability taxonomy. Operators can instead use labels such as `review`,
`economy`, `trusted`, or `regional` where those better describe routing intent.

## Breaking-change boundary

This is a pre-release breaking change. Wake must accept only the new field
names and contracts after the change:

- Do not read `tiers`, `tier`, or `defaultTier` as aliases.
- Do not emit legacy names in newly written events, projections, API payloads,
  UI data, logs, or telemetry.
- Do not retain compatibility shims, migration transforms, or deprecated
  documentation.

Existing development-only Wake homes and generated templates must be updated
as part of the implementation. The change is complete only when configuration
validation rejects the former keys through the existing strict schemas.

## Scope inventory

The implementation plan must inventory and rename each occurrence in the
active `src-next/` architecture first:

- execution configuration schema, config contracts, and bootstrap composition;
- workflow execution route contract and selection service;
- runner registry API, errors, comments, and routing/result metadata;
- event contracts, projections, API surface DTOs, UI labels, filters, and
  analytics grouping;
- fixtures, unit tests, integration tests, E2E scenarios, and generated Wake
  home configuration;
- current reference documentation, setup templates, examples, and CLI help.

The legacy `src/` tree remains behavioural evidence until its removal gate.
Its handling must be explicitly decided in the implementation plan: either
apply the same breaking rename while it remains runnable, or remove/disable
the legacy configuration surface as part of the rewrite gate. It must not be
silently left with a conflicting public vocabulary.

Historical dated design records, plans, reports, handoffs, and vision inputs
are not rewritten; they describe their original decisions and are not current
reference material.

## Acceptance criteria

1. A valid Wake-home configuration uses `execution.runnerPools`,
   `execution.defaultRunnerPool`, and per-stage `execution.runnerPool`.
2. Runner-pool member names resolve only against `execution.agentRunners`.
3. Runtime selection preserves existing ordered, same-pool fallback behavior.
4. Persisted and surfaced routing information uses `runnerPool`; no active
   public contract presents `tier` terminology.
5. Strict configuration validation rejects all three former field names.
6. Current documentation and generated templates describe runner pools as
   ordered fallback sets, not capability tiers.
7. Target-architecture verification and the applicable legacy verification
   suite pass after implementation.

## Non-goals

- Changing which runners exist or their provider/model configuration.
- Adding load balancing, weighted selection, automatic escalation, or pool
  priority across pool names.
- Supporting old configuration or transforming persisted development data.

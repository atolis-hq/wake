# Root configuration — Component Specification

## Type, purpose, and scope

Adapter. Root configuration loading translates the operator's on-disk
configuration files into the single validated, typed Root configuration
every other Bootstrap component and the composed application graph depend
on. It is the only component that reads `config.yaml` or
`config.workflows.yaml`.

## Responsibilities and boundaries

Root configuration owns reading, merging, and validating the two
configuration files a Wake home may provide. It does not own the meaning of
any individual module's settings — each module's own configuration schema
decides what its section accepts — and it does not decide which concrete
adapter a setting selects; that is Bootstrap's other components' job, once
this component has produced a validated value.

## Core policies, invariants, and behaviours

**Reading**

- `config.yaml`, resolved relative to `wakeRoot`, MUST be read and parsed as
  YAML; its absence MUST fail loading — there is no default root
  configuration.
- `config.workflows.yaml`, resolved the same way, is optional: its absence
  MUST be treated as no additional workflow configuration, not an error. Any
  other read failure for it (a permissions error, a YAML syntax error) MUST
  still fail loading.
- An empty or fully blank YAML file MUST be treated as an empty configuration
  object, not as a parse failure.

**Merging**

- The workflows file's content MUST be normalized before merging: a file
  whose top level already has a `workflows` key is treated as the whole
  `orchestration` section; a file without one is treated as a bare map of
  workflow name to workflow definition and wrapped as
  `orchestration.workflows`.
- Merging combines the main file and the normalized workflows file key by
  key: where both files define an object at the same key, the two objects
  are merged recursively (the workflows file's values win on conflicting
  leaf values); where only one file defines a key, that value is kept
  unchanged.
- The workflows file is only ever merged as an object. If its top-level YAML
  value is not an object (for example a bare list or scalar), merging MUST
  NOT attempt to fold it key-by-key into the main configuration — the
  workflows file's value replaces the entire merged configuration for that
  merge step. Operators MUST write `config.workflows.yaml` as a mapping at
  its top level to avoid this.

**Validation**

- The merged value MUST be validated against the closed root configuration
  shape: every module's own configuration schema, composed under one
  strict top-level object that rejects any key not belonging to a known
  module section.
- `orchestration.default` MUST name a configured workflow whenever at least
  one workflow is configured; an orchestration section with zero workflows
  configured is valid regardless of what `default` names, since nothing can
  route to it.
- Every `orchestration.workflowSelectors` entry MUST name a configured
  workflow; a selector naming an unconfigured workflow MUST be rejected,
  reported against that selector's own position.
- `execution.defaultRunnerPool` MUST be present; unlike most of the root
  configuration's sections, execution's section is not fully defaultable
  from an absent input.
- Validation failure MUST report every violation found, not just the first:
  each violation's field path and message are collected and reported
  together in one failure, rather than surfacing only the first schema
  issue encountered.

## Conceptual schema

**Fake-shaped integration entry** (as validated by this component before
hydration; see [fake provider evidence hydration](../fake-provider-evidence.spec.md)
for what happens to it next)

| Field | Type | Description |
| --- | --- | --- |
| `provider` | literal `fake` | Marks this integration entry as a fixture provider rather than a live one. |
| `evidenceFile` | non-empty string | Path, relative to `wakeRoot`, to the fixture's recorded inbound events. |
| `effectsFile` | non-empty string, optional | Path, relative to `wakeRoot`, to the fixture's recorded delivery effects. |

## Dependencies and system role

- Every module's own configuration schema — Root configuration composes them
  under one strict object rather than defining section shapes itself.
- Composition root (depends on Root configuration) — the composed
  application graph is built from this component's validated output and
  from nothing else configuration-shaped.

## Decisions, exclusions, and deferred capability

- Root configuration does not support multiple configuration file locations,
  profiles, or environment-variable overlays; `config.yaml` plus an
  optional `config.workflows.yaml`, both resolved relative to `wakeRoot`, is
  the entire configuration surface.
- `work`, `resources`, and `activities` currently validate only an empty
  object for their sections; any key an operator writes under those
  sections today is rejected by the strict top-level schema.

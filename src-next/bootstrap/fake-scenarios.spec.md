# Fake scenario resolution — Component Specification

## Type, purpose, and scope

Adapter. Fake scenario resolution loads an optional `fake-scenarios.yaml`
from the Wake root and parses it into the scenario resolver a `fake`-kind
runner uses to script its own responses by runner name, before the runner
registry is composed.

## Responsibilities and boundaries

This component owns locating, reading, and validating `fake-scenarios.yaml`
at composition time. It does not decide how a fake runner uses a resolved
scenario once handed one — that is Execution's own `FakeExecutionRunner` —
and it has no effect on any non-`fake`-kind runner.

## Core policies, invariants, and behaviours

- A missing `fake-scenarios.yaml` MUST resolve to an empty scenario
  resolver rather than failing composition; every other read or parse
  failure MUST fail composition outright, with the underlying validation
  error included in the thrown message.
- The file's parsed YAML MUST be validated through Execution's own
  fake-scenario schema before it is usable — this component performs no ad
  hoc shaping of its own beyond reading the file and defaulting an absent
  document to an empty object before validation.
- Resolution runs once per composed application graph, synchronously as
  part of composing the graph; its result is handed to runner registry
  composition and is never itself a durable fact.

## Dependencies and system role

- Execution — owns the fake-scenario schema, the parsed resolver's shape,
  and how `FakeExecutionRunner` consumes a resolved scenario by runner
  name; this component only loads and validates the file against that
  schema.
- [Runner registry composition](runner-registry.spec.md) (depends on this
  component) — every `fake`-kind runner is constructed with this
  component's resolver so it can be scripted by its own configured name.
- Composition root (depends on this component) — loads scenarios once,
  alongside configuration, before runners are composed.

## Decisions, exclusions, and deferred capability

- There is no fixture caching across composition roots; the file is
  re-read and re-validated every time an application graph is composed,
  mirroring fake provider evidence hydration's own behaviour.
- Only a `fake`-kind runner is ever scripted this way; no other runner kind
  reads this file.

# Runner registry composition — Component Specification

## Type, purpose, and scope

Adapter. Runner registry composition selects a concrete agent-runner
implementation for every runner an operator has configured, and assembles
them, together with the configured runner pools, into the runner registry
Execution runs against.

## Responsibilities and boundaries

This component owns mapping a configured runner's `kind` to a concrete
runner implementation and constructing it with that runner's own settings.
It does not own what a runner kind can do once constructed (that is
Execution's concern), does not decide which pool a run should draw from, and
does not validate that a runner pool's members correspond to a configured
runner — it only builds the registry those other decisions are made against.

## Core policies, invariants, and behaviours

- Selection MUST be by the configured runner's `kind` alone, against a fixed,
  closed set: `claude-cli`, `codex-cli`, `cursor-cli`, `command`, `fake`.
  `kind` names the transport adapter, not a vendor; a runner's own name (the
  key it is registered under) is a separate, operator-chosen identity used
  wherever a runner pool references it.
- Every configured runner name MUST produce exactly one constructed runner
  instance, keyed by that same name.
- A `command`-kind runner MUST have a non-empty `command` configured;
  constructing one without a command MUST fail immediately rather than
  producing a runner that would fail only once invoked.
- For every command-style kind (`claude-cli`, `codex-cli`, `cursor-cli`,
  `command`), the configured command, wall-clock timeout, and extra
  arguments MUST be passed through to the concrete constructor unchanged —
  this component MUST NOT apply its own default, override, or clamp for any
  of them.
- The configured runner pools MUST be carried into the resulting registry
  verbatim, alongside the constructed runners.

## Dependencies and system role

- Execution — supplies the runner-kind constructors this component selects
  between, and defines the registry shape being assembled.
- Root configuration (depends on, indirectly) — this component only ever
  operates on an already-validated `execution` configuration section; it
  does not itself validate runner shapes (for example, the reserved
  `--output-format`/`--resume` argument check happens during configuration
  validation, before this component runs).
- Composition root (depends on this component) — the composed application
  graph's Execution service is given exactly the registry this component
  produces.

## Decisions, exclusions, and deferred capability

- This component does not verify that every runner name listed in a runner
  pool has a matching entry among the configured runners; an unmatched pool
  member is not rejected at composition time by this component.
- Adding a new runner kind requires a corresponding constructor to exist in
  Execution; this component only ever dispatches on the closed set Execution
  already exposes constructors for.

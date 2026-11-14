# Optional fake-runner scenarios design

## Goal

Make the target-runtime fake runner useful for deterministic resilience tests
without mixing test scenarios into production runner configuration. Operators
can simulate delayed, blocked, failed, rejected, and later-successful work and
review runs, including a dark-factory workflow. A normal Wake home remains
zero-cost and immediately successful by default.

## Configuration boundary

The Wake home may contain an optional `fake-scenarios.yaml` beside
`config.yaml` and `config.workflows.yaml`. `config.yaml` continues to declare
only runner transport identities:

```yaml
execution:
  agentRunners:
    fake-worker: { kind: fake }
    fake-reviewer: { kind: fake }
```

No fake scenario fields are added to an `agentRunners` entry. Bootstrap loads
and validates `fake-scenarios.yaml` only when it exists. A missing file, an
empty rules list, or an unmatched rule preserves the current default: the
fake runner resolves immediately with `DONE`.

## Scenario file

The scenario file has a strict, versioned schema. Each rule identifies a run
by its configured runner name, workflow name, action/template, and the
activation occurrence for that workflow instance. Activation occurrence is
durable orchestration state, so a crash/restart chooses the same rule rather
than relying on an in-memory counter.

```yaml
schemaVersion: 1

rules:
  - name: refine-fails-then-recovers
    when:
      runner: fake-worker
      workflow: dark-factory
      action: refine
      occurrence: 1
    afterMs: 7000
    outcome: FAILED
    retrySafety: safe-to-retry

  - name: refine-retry-succeeds
    when:
      runner: fake-worker
      workflow: dark-factory
      action: refine
      occurrence: 2
    afterMs: 2500
    outcome: DONE

  - name: fake-review-requests-changes
    when:
      runner: fake-reviewer
      workflow: pr-review
      action: pr-review
    afterMs: { min: 1000, max: 10000, seed: 42 }
    outcome: REJECTED
    displayBody: Fake reviewer requests changes.
```

`afterMs` accepts either a positive fixed millisecond value or a bounded
seeded range. The seed makes a sampled duration repeatable. `outcome` accepts
the agent outcomes `DONE`, `BLOCKED`, `FAILED`, and `REJECTED`; `FAILED` can
declare retry safety. `displayBody` lets a fake review create observable
published feedback without pretending to review real code.

Rules are evaluated in file order and the first match wins. The loader rejects
invalid shapes, duplicate rule names, invalid ranges, or a rule that cannot
produce the declared outcome. It does not reject rules for a workflow that is
temporarily absent, allowing a scenario file to be prepared before a workflow
is enabled.

## Runtime behavior

The agent invocation contract gains only the execution metadata needed for
scenario selection: selected runner name, workflow name, action/template, and
activation occurrence. These values are supplied by the already composed
execution/orchestration path; the fake adapter neither reads the journal nor
keeps a process-local attempt counter.

On a matching rule, the fake runner waits for the resolved delay and then
returns the configured agent response. It observes cancellation while waiting,
so cancellation tests complete promptly. The result remains an in-process fake
and has no external execution identity. Transport-level failure is deliberately
out of scope for the first scenario format: configured `FAILED` is an agent
outcome and exercises workflow retry routing. A later extension can add an
explicit transport-failure rule without conflating it with agent failure.

## Dark factory

`wake-next` receives a `dark-factory` workflow selected by a
`dark-factory` label. Its normal stages route through `fake-worker`; its
existing plan-review and PR-review watcher workflows route through
`fake-reviewer`. Scenario rules choose the worker and reviewer outcomes.
This permits tests of approval, changes requested, safe retry, blocked review,
and watcher side effects without any real model invocation.

## Verification

Unit tests prove schema validation, default-pass behavior, fixed and seeded
delays, cancellation, ordered matching, outcomes, and restart-stable matching.
Composed E2E tests prove a delayed failed worker attempt is retried and then
succeeds, and that fake plan/PR reviewer outcomes cause the expected watcher
approval, feedback, and merge-gating side effects. Documentation describes the
optional file and an example dark-factory setup.

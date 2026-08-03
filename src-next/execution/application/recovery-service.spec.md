# Recovery — Component Specification

## Type, purpose, and scope

Policy/process. Recovery reconciles a Run whose lease has expired with the
real state of its external execution, so a crashed owner's Runs do not stay
`started` forever. It is the only component that inspects an external
execution's actual state rather than trusting a Run's own recorded facts.

## Ubiquitous language

See the module specification for Recovery and External execution reference.
This component additionally defines the **inspection outcome** it acts on:
`running`, `completed` (with a `AgentRunnerResult`), `absent`, or `unknown` (with
a reason) — reported by an injected external-execution inspector.

## Responsibilities and boundaries

Recovery owns deciding what to do with one expired-lease Run: re-lease it to
a new owner if its execution is still genuinely running, record its
recovered success or failure if it has completed, record a failure if the
execution is simply absent, or record an unresolved ambiguity if inspection
cannot tell. It also owns scanning every `started` Run for lease expiry and
recovering each. It does not itself talk to any specific runner or provider
— that is delegated entirely to the injected inspector — and it does not
decide whether a further attempt should be started afterward; that remains
the Execution service's concern once the Run is out of `started`.

## Core policies, invariants, and behaviours

- Recovering a Run that does not exist MUST fail with an error. Recovering a
  Run that exists but is not currently `started` MUST be a no-op that
  returns its current view unchanged.
- Recovering a `started` Run whose lease is present and not yet expired
  MUST fail with an error — Recovery MUST NOT act on a Run that still has a
  live, unexpired lease. A `started` Run with no lease at all is treated as
  eligible, the same as an expired one.
- A `started`, lease-eligible Run with no recorded external-execution
  reference MUST be recorded as failed, without attempting inspection —
  there is nothing for the inspector to look up.
- When inspection reports the execution is still `running`, Recovery MUST
  re-lease the Run to the recovering owner (recorded as a lease-renewal
  fact) and MUST NOT record any terminal fact — the Run remains `started`
  under new ownership.
- When inspection reports the execution `completed`, Recovery MUST derive
  the Run's outcome by validating the reported result's output against the
  Activity's own outcome schema, and record a recovered fact carrying that
  result, outcome, and finish time. The reported result MUST have transport
  `succeeded`; Recovery has no handling for a `completed` inspection that
  reports any other transport or an output that fails outcome validation —
  either causes recovery to fail with an error rather than record a
  `failed` or `ambiguous` Run.
- When inspection reports the execution `absent`, Recovery MUST record the
  Run as failed.
- When inspection cannot determine the execution's state (`unknown`),
  Recovery MUST record the Run as `ambiguous`, carrying the inspector's own
  reason text.
- Every append MUST re-check the Run's current status immediately before
  writing: if some other process has already moved the Run out of `started`
  between the initial read and this append, the append MUST be skipped and
  the Run's current (already-updated) view returned instead, rather than
  overwriting it or erroring.
- Recovering every active Run MUST consider every `started` Run in the
  journal (not scoped to one Activation), acting only on those whose lease
  is absent or expired, and MUST process them one at a time.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `execution.run-lease-renewed` | Inspection finds the execution still running | The Run is re-leased to the recovering owner and remains `started`. |
| `execution.run-recovered` | Inspection finds the execution completed successfully | The Run's terminal `succeeded` status and outcome are derived from the recovered result. |
| `execution.run-failed` | No external-execution reference was ever recorded, or inspection finds the execution absent | The Run is recorded as failed without a successful outcome to recover. |
| `execution.run-ambiguous` | Inspection cannot determine the execution's state | The Run is terminal but its real outcome is unresolved. |

## Conceptual schema

**Inspection outcome** (returned by the injected inspector, not durable)

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `running` / `completed` / `absent` / `unknown` | What the inspector found for a Run's external execution reference. |
| `result` | Runner result | Present only on `completed`; the recovered transport result. |
| `reason` | string | Present only on `unknown`; why the state could not be determined. |

## Dependencies and system role

- Kernel — event envelope conventions and the Run stream's append sequence
  this component reads before appending.
- Run (co-owns the Run stream with) — this component's facts are folded by
  the Run aggregate's own fold, including the terminal statuses it produces.
- Run liveness and cancellation (reuses) — the lease-renewal event shape,
  for the re-lease-on-still-running case.
- An external-execution inspector (Recovery depends on, injected) — the
  only thing that actually knows how to check a process or remote session's
  real state; not implemented by this component.
- Activities (Recovery depends on) — validates a recovered result's parsed
  output against the Activity's declared outcome schema before it can be
  recorded as a successful recovery.
- Control-plane (depends on, via the recovery coordinator) — calls recovery
  across every active Run before dispatching new work, so a crashed owner's
  Runs are resolved before anything else touches them.

## Decisions, exclusions, and deferred capability

- There is no handling for a `completed` inspection whose reported result
  is not itself successful, or whose output fails outcome validation —
  Recovery surfaces these as thrown errors rather than translating them
  into a `failed` or `ambiguous` Run. Any inspector implementation MUST only
  report `completed` for an execution whose result is genuinely successful
  and schema-valid, or Recovery's handling of that Run will fail outright
  rather than record a terminal fact for it.
- There is no command to resolve or retry an `ambiguous` Run from within
  Recovery or the wider Execution surface; see the module specification's
  own deferred-capability note.

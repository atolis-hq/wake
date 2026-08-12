# Operator Retry for Blocked Failed Work Design

## Goal

Allow an operator to retry the current workflow stage only after Wake has
durably blocked it for an unconfigured `failed` activity outcome. The retry is
an orchestration recovery command: it creates a new activation and therefore a
new Run, without changing historical activations, Runs, or facts.

## Recovery boundary

The command is eligible only when all of the following are true:

- The supplied WorkItem exists, is open, and is not deleted.
- Its primary WorkflowInstance exists and is `blocked`.
- The blocking reason is exactly the failed-outcome recovery case,
  `unconfigured outcome failed`.
- The pending activation is the completed ordinary stage activity, and the
  most recent accepted outcome is `failed` for that activation.

The command rejects every other state with a conflict reason that identifies
why recovery is not safe or meaningful. In particular, it cannot revive a
completed, waiting, active, superseded, or differently blocked workflow, and
it cannot retry supplemental or follow-on activity through this command.

Frozen open work remains retryable: the recovery is durably queued, while the
existing dispatch policy defers execution until the operator unfreezes it.

## Durable orchestration behavior

Introduce `orchestration.operator-retry-requested`, carrying the recovered
activation identity and the command identity. For an eligible command,
Orchestration appends this fact and a new `orchestration.activity-requested`
fact atomically. The new activation has the next ordinal and uses the current
stage's compiled activity, input, and execution configuration.

The WorkflowInstance fold records the latest block reason and successful
operator retry command identities. On replay of the same command identity,
the service returns the current workflow view without appending anything,
even though the workflow is now active. This is durable across process restart
and prevents duplicate activations. Different retry commands after recovery
are rejected because the workflow is no longer blocked.

`ActivityRequested` remains the only event that returns the instance to
`active`; it clears any wait state and makes the new activation dispatchable.
The existing execution path then creates a separate Run for it. Earlier Run
and activation facts are retained unchanged.

## Surface behavior

The existing `POST /api/v1/work-items/:workItemKey/commands/retry` route is
composed with the Work surface application. It resolves the primary workflow
for the WorkItem and calls the orchestration recovery service with the API
idempotency key as its command identity. Ineligible recovery is surfaced as
the established HTTP 409 problem response.

Work detail derives eligibility from its returned primary orchestration view:
blocked status, failed last outcome, completed ordinary activation, and the
specific recovery block reason. It renders Retry only in that state. The
button shares the existing command mutation: it disables while pending,
displays request errors, and refreshes detail and board cache entries after an
accepted command.

## Tests and documentation

Focused coverage proves a failed runner outcome becomes blocked, operator
retry creates a new activation and Run while retaining the first, and repeated
idempotency keys create no duplicate activation. Unit/API tests prove invalid
states return a clear conflict. Web tests prove the Retry control is conditional
and dispatches the command successfully. Broader orchestration, API, web, and
project suites verify contracts and formatting.

Update the workflow/operator documentation and the UI mutation exclusion to
distinguish this fixed-parameter recovery from the still-excluded ability to
rerun an arbitrary Run with changed parameters.

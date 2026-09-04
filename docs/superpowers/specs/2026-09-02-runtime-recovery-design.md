# Runtime Recovery Design

## Outcome

Wake upgrades must not wedge rebuildable projections, a scheduler dispatch must
not retain coordinator locks while an activity executes, and a failed processor
must expose its actual error without creating a hot filesystem retry loop.

## Projection compatibility

The orchestration projection will stop persisting decoded event history. Its
stored value will contain only the current folded workflow view. The domain
fold will expose a single-event continuation operation so the projection does
not duplicate transition policy. Historical projection values are not read or
upcast. Projection rebuild is an offline maintenance operation: sandbox
deployments stop the container, run
`wake validate-state --rebuild-projections --no-sandbox`, and start the
container again; host/service deployments stop and restart their resident via
their supervisor. The existing CLI rebuild clears and replays every registered
projection while the journal remains authoritative and unchanged. No
authoritative journal migration is required.

## Dispatch lifetime

The activation scheduler remains responsible for selection, validation,
claiming, and durable run preparation. It must return once execution has been
durably started instead of awaiting immediate runner completion. Execution's
resident lifecycle owns the subsequent workspace, runner, completion, and
outcome events. Consequently the Eventing subscription lock and the scheduler
critical-section lock cover only bounded dispatch work.

Startup/fallback reconciliation remains a recovery lane, but it must not spin
against a held filesystem lock. Filesystem processor-lock acquisition will use
bounded exponential backoff rather than a fixed 10 ms retry.

## Observability

Processor health responses will include the bounded last processor error when
present. Existing health status, checkpoint, lag, and failure-count semantics
remain unchanged.

## Verification

Regression coverage will prove canonical orchestration projection replay,
scheduling returns with a preparing run before runner completion, contended
filesystem locks back off, and health includes the processor error. Focused
unit/integration tests run first, followed by the repository verification gate.

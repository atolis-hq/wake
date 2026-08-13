# Execution invariants

Wake records execution as durable facts rather than inferring it from a live
agent process. The current guarantees are implemented by `execution`,
`orchestration`, and `control-plane`:

- An activity attempt is represented by a Run stream. Run lifecycle, lease,
  runner result, cancellation, recovery, and ambiguity facts are typed
  `execution.` events.
- Execution never advances a workflow itself. Orchestration accepts a durable
  activity outcome and interprets the configured route.
- A dispatch is claimed before an external runner is invoked. Leases have a
  configured duration and renewal path, making incomplete work visible to
  recovery after a restart.
- Cancellation and recovery append facts to the Run stream; they do not mutate
  a prior result or rely on process-local history.
- Workspaces are optional execution infrastructure. Workspace preparation and
  cleanup do not define workflow state.
- Raw transcript capture is opt-in, filesystem-only, and subject to configured
  retention; it is not inserted into the event journal.
- The control plane applies bounded selection and dispatch through the same
  `advanceOnce` capability for tick, resident, and scheduled hosts.

The executable contracts live in `src/execution/`, with cross-domain
advancement in `src/control-plane/` and `src/orchestration/`. See
[Architecture](architecture.md) for the complete flow.

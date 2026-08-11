# Work Conclusion — Component Specification

## Type, purpose, and scope

Policy/process. Work Conclusion is the single, adapter-neutral process by
which an already-admitted WorkItem is concluded because its correlated
external object reached a terminal state outside Wake — mirroring Work
Admission's own shared seam for the opposite direction.

## Responsibilities and boundaries

Work Conclusion owns translating a provider-neutral outcome
(`completed`/`cancelled`) into a close-or-cancel call against the
caller-injected `WorkConclusion` cascade, and the idempotency check that
makes a duplicate or self-echoed observation a safe no-op. It does not
decide when an external object reached a terminal state — that is each
provider's own inbound translation. It does not itself implement what
closing or cancelling a WorkItem does beyond that call — the injected
`WorkConclusion` cascade (composed by Bootstrap) owns that.

## Core policies, invariants, and behaviours

- A call for a WorkItem that cannot be found, or whose current state is not
  Open, MUST be a no-op — it does not call `closeWork`/`cancelWork` and
  does not error. This makes a duplicate observation, a replayed event, or
  Wake's own conclusion echoing back through a later poll all safe to call
  again.
- Outcome `completed` MUST call `closeWork`; any other outcome MUST call
  `cancelWork`; both carry the caller's own reason string unchanged.
- This process MUST NOT rely on `WorkService`'s own throw-on-non-Open guard
  for idempotency — it checks current state itself first, so a caller never
  needs to catch a rejection from this process for the already-concluded
  case.

## Conceptual schema

**ConcludeObservedWork** (the process's own input)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity | The already-admitted WorkItem to conclude. |
| `outcome` | closed vocabulary: `completed` / `cancelled` | The external object's own terminal disposition. |
| `reason` | string | Recorded as the close/cancel call's own reason. |

## Dependencies and system role

- Work (Work Conclusion depends on it) — `get`, to check current state
  before concluding.
- `WorkConclusion` cascade (Work Conclusion depends on it) — supplied by
  the caller, composed by Bootstrap from control-plane's own conclusion
  policy; Work Conclusion only calls `closeWork`/`cancelWork` through it and
  does not implement the cascade itself.
- GitHub Inbound Translation (depends on Work Conclusion) — the current
  caller, invoked when a reobserved object's evidence carries a terminal
  outcome.

## Decisions, exclusions, and deferred capability

- Work Conclusion does not itself detect that an external object reached a
  terminal state; that determination, and the outcome value it passes in,
  belong entirely to the calling provider's own inbound translation.

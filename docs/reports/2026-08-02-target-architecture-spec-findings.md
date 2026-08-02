# Target architecture spec findings — 2026-08-02

Surfaced while writing the `src-next/` behavioural specifications (Task 27A).
Each finding is grounded in the actual `src-next` source and, unless noted
otherwise, is also recorded in the relevant module or component spec's own
"Decisions, exclusions, and deferred capability" section. This document
exists to walk through each one and record a decision — it is a working
document, not itself a specification.

Recommendation is a starting opinion, not a ruling. **Decision** is blank —
fill it in as each row is discussed (e.g. "accept as deferred", "fix before
cutover", "track as issue #NNN", "reject — intentional").

## kernel

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| K1 | No schema versioning/migration policy | Kernel fixes `schemaVersion: 1` as a literal; there is no mechanism to evolve an event payload's shape across versions. | Decide whether this is needed before any payload shape needs to change post-cutover, or stays deferred until it's actually needed. | |
| K2 | Relations are establish-only | Kernel's relation primitive has no removal/amendment; a module that needs a revocable relation (e.g. Resources' correlation retraction) builds that itself on top. | No action — confirm this is the intended layering (kernel primitive stays minimal, modules own revocation semantics). | |
| K3 | No cross-module identity-prefix registry | `IdGenerator` doesn't track or reserve ID prefixes across modules; avoiding a collision between two modules' identity kinds is a convention, not an enforced invariant. | Low priority; consider a lint/check only if a real collision ever occurs. | |
| K4 | Only one concrete Clock/IdGenerator shipped | Kernel ships `SystemClock`/`UlidIdGenerator` as its only reference infrastructure; every module builds its own fake/deterministic variant individually rather than sharing one. | Consider whether a shared fake Clock/IdGenerator at kernel level would reduce duplication across module test fakes — minor, not urgent. | |
| K5 | `CheckpointStore.save` must reject a position regression | This invariant is enforced by both reference implementations but isn't visible from the bare port interface itself — a new implementation could silently violate it. | Consider a doc comment on the interface, or a shared contract test any new `CheckpointStore` implementation must pass. | |

## work

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| W1 | No reopen path for closed/cancelled WorkItem | Lifecycle exit is permanent by design; a new need becomes a new WorkItem. | Confirm intentional (this was an explicit design choice in the pilot, not a gap found afterward) — no action expected. | |
| W2 | No objective history retained | Only the current objective is a durable fact of the read model; prior objectives live only in the raw event log. | Confirm intentional; low risk. | |
| W3 | Relation graph consistency unenforced | Work does not reject cycles (e.g. `child-of` cycles) among its own relation kinds. | Check whether anything downstream (e.g. Orchestration's group/child hierarchy) assumes acyclicity and would be affected by a cycle Work allows. | |

## resources

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| R1 | No command to issue a revision update | `resources.resource-revision-observed` is fully modeled in the fold and projections, but no application-boundary command emits it; revision updates today only happen by re-issuing discovery. | Decide whether a dedicated revise-revision command is needed, or re-discovery is the permanent intended pattern. | |
| R2 | Kind/capability extension point unused | An open-vocabulary mechanism for registering additional resource kinds/capabilities exists but nothing currently registers beyond the built-in set. | Low priority — confirm deferred, not abandoned. | |
| R3 | Correlated WorkItemId existence unverified | A correlation may be recorded (and later retracted) against a `WorkItemId` Resources has no other knowledge of; Resources never checks Work for existence. | Decide if this should call Work to validate, or stay loose since Resources deliberately doesn't own Work lifecycle. | |

## activities

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| A1 | Merge-authority gate not wired into any workflow step | `authorizeMerge`/`decideAuthority` are implemented and exported but never invoked from production composition — merge authorization isn't currently a reachable step in any real workflow. | Likely needs prioritizing — this reads as a safety-relevant gate that exists but isn't load-bearing yet. Decide whether to wire it into a workflow step before cutover. | |
| A2 | `activities.` event namespace and `activity.` relation namespace reserved but unused | Every emitted event is currently `pr.*`/`review.*`; no relation kind is defined despite the reservation. | Low priority — leave reserved, or drop the reservation if genuinely not needed. | |
| A3 | No built-in Activity declares a `ResourceRequirement` | `agent`, `pr.approve`, `pr.merge` each resolve their own target Resource internally rather than through the declared resource-requirement mechanism; a `blocked` outcome (not a validation failure) results when resolution fails. | Confirm this bypass of the general resource-resolution path is intentional, not an oversight in how the built-ins were ported. | |
| A4 | Review-signal proposal is a pass-through | `proposeReviewSignal` validates nothing beyond input shape; trust is enforced entirely downstream in Authority. | Confirm acceptable — likely fine since Authority is the actual trust boundary, but worth a second pair of eyes. | |

## orchestration

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| O1 | Supplemental commands restricted to `auto`/`watch` authority are unreachable | `isAuthorisedActor` only ever resolves `EventActorKind.Operator`/`Integration` to `ApprovalAuthorityKind.Human`; no actor kind currently maps to `auto` or `watch`. A supplemental command configured with `allowedActors: ['auto']` or `['watch']` can never be invoked today. | Decide whether to implement the missing actor-kind mappings, or have config validation reject an unreachable `allowedActors` value instead of silently accepting dead configuration. | |
| O2 | Child-completion reconciliation isn't durably/scoped retried | A child's completion is only recorded once its parent is actually `waiting` for that signal kind; otherwise nothing is recorded, and reconciliation is re-attempted only via an unconditional, system-wide sweep whenever *any* instance's outcome is accepted anywhere. | Assess latency/blast-radius at scale; consider a targeted retry scoped to the affected parent/child pair instead of a global sweep. | |
| O3 | Causal-repeat check is non-atomic with reject-or-request | `watch-reactor.ts` reads `isCausalRepeat` and then separately calls reject/request with no compensating lock; safety currently relies on deterministic request-id derivation plus an idempotent no-op. | Re-verify safety once parallel tick execution lands (per project context, "parallel work is coming" is an explicit upcoming change) — this is exactly the kind of check-then-act gap that breaks under real concurrency. | |
| O4 | Stage-level waits are authority-gated; Activity-reported waits are not | A Stage's own `await` route always declares a non-empty authority `from` list (schema-enforced); an Activity's self-reported `waiting` outcome never carries one, so any authority can resume it. | Decide whether this asymmetry is intentional (the Activity already vetted its own resumption condition) or a gap that should also carry an authority list. | |
| O5 | `instance-superseded` modeled but never produced | The event type and `superseded` status exist in the vocabulary and fold, but no current decision policy ever triggers supersession. | Low priority — confirm deferred capability, not a missing wire-up. | |
| O6 | No release path for primary/budget claims | A primary-workflow claim and a per-Watch group budget claim are permanent for the orchestration group's lifetime; there's no command to release either, even after the WorkflowInstance completes or blocks. | Assess whether this causes unbounded accumulation over long-running deployments; may need a release path eventually. | |
| O7 | `workflow.` relation namespace reserved but unused | Parent/child and WorkItem linkage are carried only as event payload fields (`workItemId`, `parentWorkflowInstanceId`), not as queryable kernel relations. | Decide if cross-module relation querying is actually needed here, or payload fields are sufficient permanently. | |

## execution

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| E1 | No way to resolve or retry an `ambiguous` Run | Recovery only records the ambiguity; a further `attempt` call keeps returning the same ambiguous Run unchanged, with no operator-facing resolution path. | Likely needs prioritizing — this can strand work indefinitely. Decide on an explicit resolution command/flow. | |
| E2 | `maxTurns`/`allowedTools` declared but never forwarded | `RunnerRequest` declares both fields (shared with Activities' agent-runner port), but no current CLI runner adapter (`claude`, `codex`, `cursor`, `command`) reads or forwards either one when invoking its process. | This contradicts the documented "operator policy, passed through verbatim" contract (see CLAUDE.md). Either wire these through in the adapters or remove them from the contract until implemented — don't leave a documented guarantee silently unmet. | |
| E3 | Runner pool failover never crosses pools | When the resolved runner is quota-ineligible, Execution only tries the next candidate within the same pool. | Decide if cross-pool failover is wanted for resilience, or single-pool is the intended blast-radius boundary. | |
| E4 | `command` runner variant ignores the entire `RunnerRequest` | Including the prompt — it always invokes a fixed command+args regardless of what was requested. | Confirm this is intentional (e.g. a fixed health-check/smoke runner) rather than a broken adapter that should be reading its input. | |
| E5 | Transcript persistence not wired into production attempt flow | The infrastructure exists (`writeTranscript`) but nothing in the composed attempt path calls it. | Decide if this is needed before cutover for debugging/audit, or stays deferred. | |
| E6 | `RecoveryService.appendRecovered` has no failure path for a bad "completed" report | If an `ExternalExecutionInspector` reports `completed` with a non-`succeeded` transport, or output that fails Activity-outcome schema validation, `recover()` throws unconditionally instead of recording `failed`/`ambiguous`. | Decide the correct semantics here — an inspector implementation bug or a legitimate edge case shouldn't be an uncaught throw in a recovery path. | |
| E7 | `RunnerResult.transport` permits `cancelled`/`ambiguous` that no adapter produces | A Run's terminal `cancelled` status comes entirely through the separate lease/cancellation protocol, never through a runner-reported transport value. | Low priority — confirm these vocabulary values are deliberate future-proofing, or trim them. | |
| E8 | Transport status and Activity outcome can diverge | A Run's transport status can be `succeeded` while its Activity outcome is `failed` (the process ran fine; what it produced didn't validate/succeed). | No code change needed, but make sure anyone reading `RunView.status` for "did this work" doesn't misread transport success as task success — worth an explicit callout wherever this is surfaced to operators. | |
| E9 | `RunRepository.list()` does a full journal scan every call | Used by `attempt`'s existing-Run check, the cancellation cascade, and Recovery's scan — none of them use the checkpointed/registered Run projection. | Performance concern at scale; consider switching these call sites to the projection. | |
| E10 | Prompt-template `extraArgs` field is validated but never read | Dead field — accepted by the schema, never consumed anywhere. | Low priority — wire it up or remove it from the schema. | |

## integrations

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| I1 | GitHub review-signal polling is unreachable end-to-end | The review-source builder produces `integration.github.comment-observed` evidence, and the inbound translator fully consumes it for `/accepted`/`/changes` commands — but `createGitHubClient` has no review-listing call, and `source.ts`'s `poll()` never invokes the review-source builder. Review acceptance signals cannot currently reach Activities through polling at all. | Likely needs prioritizing — this looks like a genuine, currently-invisible functional gap in the PR review flow. | |
| I2 | CLAUDE.md's GitHub label-reconciliation guarantee isn't implemented | `reconcileGitHubWakeLabels`/`isGitHubWakeEcho` are implemented and unit-tested in isolation but never called from the composed inbound/outbound pipeline; there's no outbound action that writes a label back to GitHub at all. | This is a repo-wide documented guarantee ("GitHub wins for stage, local files win for history/attempts", reconciled every tick). Decide whether to implement it before cutover or formally revise the guarantee's wording to match target reality. | |
| I3 | Duplicate, unwired `PollService` | `github/application/poll-service.ts` has its own `PollService` class (no dedup-by-eventId) not used by the composed provider; only its type is reused elsewhere. Already flagged for deletion in an existing planning doc. | Just delete it — low effort, already decided elsewhere. | |
| I4 | GitHub delivery `reconcile()` always returns `Unknown` | Unlike the fake delivery provider, it never actually queries GitHub — an ambiguous or crash-interrupted GitHub delivery can never resolve automatically; it loops on `unknown` forever until an operator intervenes. | Likely needs prioritizing — implement a real reconciliation query, or make the stuck state clearly operator-actionable/visible in the meantime. | |
| I5 | Approve delivery drops the intent's own body | `client.ts`'s `deliver()` hardcodes the review body to just the idempotency marker for `pr.approve`, ignoring `intent.payload.body` even though the payload declares an optional `body`. | This reads as a straightforward bug — fix to forward the intent's body. | |
| I6 | Capability grants diverge between GitHub and fake translators | The real GitHub inbound translator grants a new PR resource only `commentable`/`reviewable`/`revisioned`; the fake translator also grants `approvable`/`mergeable`/`changed-files`. Currently harmless (no built-in Activity declares a `ResourceRequirement` — see A3), but would silently diverge fake-vs-real behaviour the moment one does. | Align the two capability lists now, before that becomes a live discrepancy. | |
| I7 | `github.publication.postStatusComments` config field is dead | Parsed by config schema, never read by any delivery or translation path. | Low priority — wire up or remove. | |

## control-plane

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| C1 | Global dispatch pause is unreachable | `advance-once.ts` never reads the global dispatch pause; `HostStopReason.Paused` is defined in the type but no code path ever produces it. | Decide if global dispatch pause is still a wanted capability — if so, wire it into Advancement; if not, remove it from the type/vocabulary rather than leave dead surface area. | |
| C2 | CLI tick and API `advance` run materially different pipelines | Both are described as "Advancement," but the CLI's `TickHost` runs the full poll/translate/react/advance/deliver/react pipeline (`root.pipeline.run`) while the API's direct `advance` command calls bare `advanceOnce` with none of those stages. | Needs a decision — this is a real behavioural inconsistency between two operator-facing entry points that share a name. Either align them or document the difference explicitly so it isn't assumed to be the same operation. | |
| C3 | `TickHost`'s `advances`/`runs` counters never diverge | Only `progressed` results increment either counter, and always together, even though `HostBudget` models `maxAdvances`/`maxRuns` as independent caps. | Low priority — simplify the model to one counter, or confirm future divergence is actually expected and the model is right, just unexercised so far. | |
| C4 | `ResidentHost.run`'s returned stop reason is always `Shutdown` | Regardless of what actually caused the last cycle to stop, the returned `stoppedBecause` is unconditionally forced to `Shutdown` on every return path. | This reads as a bug — if anything (operator tooling, monitoring) relies on this field to know *why* the resident loop stopped, it's currently always wrong except on genuine shutdown. Recommend fixing to report the real reason. | |
| C5 | `ScheduleService` isn't crash-idempotent between minting a WorkItem and checkpointing | A crash between `orchestration.start` and the slot's checkpoint save can duplicate a WorkItem for the same slot, because (unlike `WorkflowInstanceId`) the minted `WorkItemId` isn't deterministic per slot. | Needs a decision before Schedule Service is wired into production (see C8) — likely fix by deriving a deterministic WorkItem identity per slot, matching how WorkflowInstance identity already works. | |
| C6 | `unpause` never checks the runner is actually paused | It appends `RunnerResumed` unconditionally once the runner name validates; command idempotency for pause/unpause is in-memory only, not durable across a process restart. | Decide if that's acceptable for now, or needs a durable idempotency check before being operator-facing. | |
| C7 | Work-cancellation cascade has no rollback on partial failure | `WorkCancellationPolicy` shares one `CommandContext`/`commandId` across the Work-cancel call and every subsequent per-workflow block call in the cascade; if a block call partway through is rejected, there's no compensation. | Decide the intended partial-failure behaviour (retry, compensate, or accept a partially-completed cascade as visible/logged) rather than leave it implicit. | |
| C8 | Dispatch Policy and Schedule Policy aren't composed into any production path | Both are implemented as pure decision logic but never invoked by a composed host; `controlPlane.maxDispatches` and `controlPlane.schedules` are validated configuration with no consumer today. | Decide wiring priority — several other findings above (C1, C5) assume these eventually get composed in. | |

## persistence

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| P1 | No persistence configuration surface despite owning the namespace | Lock staleness and projection batch size are hardcoded; `persistence` config namespace is reserved but nothing validates or reads operator settings for it yet. | Low/medium — implement the config surface, or drop the reserved namespace claim if it's not actually needed. | |
| P2 | Journal has no compaction, archival, or deletion | It grows unbounded, and a rebuild always replays it in full from the start. | Decide on a retention story before long-running production use — this is a capacity-planning question, not urgent today. | |
| P3 | No blocking/automatic retry on lock contention | A caller that loses a lock-acquire race gets an immediate failure and must decide whether/when to retry itself. | Spot-check that all current callers actually handle this correctly rather than assuming it. | |
| P4 | Corrupt on-disk state throws at read time, no auto-repair | A malformed envelope or out-of-order global position is a thrown error; persistence never attempts automatic repair (manual `doctor --rebuild-projections` is the intended remedy for projections; there's no repair path for a corrupt journal itself). | Confirm acceptable as-is — likely fine given the manual-rebuild design philosophy, but worth explicit sign-off given the journal is authoritative. | |
| P5 | CLAUDE.md's `eventStampNow`/`ingestedAt`/no-`eventId`-tie-break guarantees describe legacy `src/`, not `src-next` | `src-next` achieves the same durability/determinism properties differently (`recordedAt` stamped fresh per append, `globalPosition` assigned once monotonically, no replay-time re-sort at all). Not a code gap — a documentation-accuracy issue. | Update CLAUDE.md's architecture section once `src-next` becomes `src/` at cutover (Task 28), so it describes the actual mechanism instead of the superseded one. | |

## bootstrap

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| B1 | `work`/`resources`/`activities` accept no configuration yet | Each module's config schema validates only an empty object; root config reserves a key for each for future use. | No action needed until one of those modules actually needs operator configuration. | |
| B2 | One composition root per `wakeRoot` per process | Bootstrap doesn't support composing two independent application graphs against the same Wake home within one process. | Confirm this matches the intended single-tenant-per-process deployment model — low risk. | |

## surfaces

| # | Title | Description | Recommendation | Decision |
| --- | --- | --- | --- | --- |
| S1 | No authorization is exercised anywhere | Every surface's ownership statement anticipates checking caller identity/permission, but no surface currently does — any well-formed, validation-passing request runs unconditionally. | Needs a decision before surfaces are exposed beyond a fully trusted single operator — this is a real security-relevant gap, not a stylistic one. | |
| S2 | Five CLI commands exist but aren't reachable through the parser | `init`, `sandbox`, `doctor`, `self-update`, and `smoke` exist as composable functions under `cli/commands/`, but the CLI parser only recognizes `tick`, `start`, `stop`, `api`, `ui`, `audit`, `correlate`, `validate-state`. Directly related to the Task 26 completeness gap already discussed separately. | Wire these into the parser (or an equivalent invocation path) as part of closing out Task 26 — see the separate Task 26 assessment for the fuller picture (these commands are also thin/mocked internally, not just unreachable). | |
| S3 | Web client and API share no runtime code | The web client decodes every response field defensively (an unknown/missing field throws) rather than trusting that the API and web packages were built together. | Confirm intentional (defensive-by-design) rather than a gap — likely fine as-is. | |
| S4 | `board`/`status` API capabilities are optional | A runtime that doesn't compose them reports the route as unavailable rather than omitting it from routing entirely. | Confirm intentional; low risk either way. | |

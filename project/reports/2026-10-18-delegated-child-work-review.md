# Delegated child work: independent design review

**Date:** 2026-10-18.
**Implementation reviewed:** `25ef4657d2f1eda6e66b0282d09672cc053d6d89`.
**Review target:** the uncommitted refinements to [delegated child work](../specs/delegated-child-work.md) and [delivery oversight](../specs/delivery-oversight.md).
**Method:** a separate agent performed a read-only review of the draft and current contracts/implementation. The author checked the source evidence, corrected the spec and requested a bounded independent re-review. No Superpowers, runtime changes, issues or dispatch were used.

The review found four implementation-blocking contract gaps and two further correctness gaps. All six were addressed in the spec. The independent re-review found no further architectural blocker and requested two narrower clarifications, also applied below. This is design-level closure, not evidence that the proposed behavior is implemented or correct at runtime.

## Findings and disposition

### P1: cohort identity collides with artifact grant identity

A cohort contains multiple children, but the existing [artifact grant registration](../../src/artifacts/application/artifact-context-service.ts) deduplicates by `delegationId` within the parent stream and rejects a different child payload. Reusing the cohort ID would fail on the second child.

**Resolution:** keep the cohort ID and derive an immutable per-child grant ID from cohort, child and grant revision. Additional prerequisite/context grants have their own IDs; replay uses the same payload. Reuse the existing grant service without another registry. D2 owns production wiring and DC-31 proves multi-child registration/replay.

### P1: successful joins cannot handle a child needing attention

A required child could request clarification or exhaust its retries while the parent waited for successful results. The draft mentioned parent continuation without specifying how it runs before the join succeeds. Deferring correction machinery to D6 left the first investigation release incomplete.

**Resolution:** D2/D3 include a durable, coalesced parent-attention activation using the existing activity/outcome mechanism. It batches blockers, leaves the cohort unresolved and permits scoped assignment-context responses, already-authorized recovery or explicit escalation. Human approval and exhausted budgets cannot be bypassed. Attention and join continuations serialize on the parent; a static delegation activity without an attention handler escalates rather than resubmitting. DC-32 covers this path.

### P1: terminal PR ownership has no post-result action path

The child can finish with an open PR, but the draft then required child-scoped merge/correction without a runnable child workflow. Existing [primary claims](../../src/orchestration/application/coordination-claims.ts) retain their owner, and [PR authority](../../src/activities/pr/policy.ts) requires the PR's primary WorkItem. Existing [merge execution](../../src/activities/pr/merge.ts) reads authority using the invoking WorkItem, so passing a child PR ID alone does not solve this.

**Resolution:** a concrete configured parent integration activity receives a server-issued target naming the output-owning child, exact PR/revision, permitted action and candidate decision. Target-specific PR authority remains in force; the requesting Run/outcome stays on the parent workflow. No child primary is reopened and no PR correlation moves. D6a must implement this extension. Existing-PR agent maintenance is a separately permitted D8 activity under the target branch lease, with actual producer provenance and fresh evidence.

For a terminal child's defect, the initial correction path creates a replacement PR owned by the corrective child. If the original is unmerged, the replacement includes the original contribution plus the correction and targets the intended integration branch. Its starting checkout commit and logical PR base are distinct. D4 explicit checkout plus agent replay/cherry-pick supplies this without a hidden D8 dependency. Superseded PR cleanup is separate agent work under explicit authority. DC-33 covers ownership and terminal integration.

### P1: a local candidate SHA is not reconstructible QA input

Assembly produced a local commit in a disposable workspace; QA used a separate pinned checkout. Current [read-only workspace preparation](../../src/execution/infrastructure/workspace/git-workspace.ts) fetches from origin. A reported local SHA alone cannot satisfy that contract or survive cleanup.

**Resolution:** the assembly agent pushes a candidate-specific ref to an authorized repository. Wake verifies the fetch source/commit, records it and retains candidate/input revisions through QA, integration and unresolved recovery. Agent cleanup is gated on retention eligibility. DC-34 deletes the assembly workspace and restarts before QA, and rejects missing/moved sources. A bundle remains a deferred alternative, not another required first-release backend.

### P2: an explicit dependency DAG can still deadlock on joins

A child waiting for its ancestor's future result can deadlock against that ancestor's child join without an explicit edge cycle. Likewise a required child can wait for a sibling's merge while the parent withholds every merge until the same cohort completes.

**Resolution:** validate declared wait/phase obligations as well as explicit edges. Reject unresolved ancestor prerequisites crossing the enclosing join and same-join merged prerequisites that cannot integrate independently. Accepted ancestor context remains usable. Agents may choose incremental cohorts or permitted independently integrating workflows. This does not require a prose dependency inference engine. DC-35 covers both deadlocks.

### P2: planned merges need explicit progress/freshness semantics

The first approved merge advances a shared base. Treating every base move as an unrelated invalidation could repeatedly invalidate the approved candidate during its own integration, including squash/retarget cases.

**Resolution:** retain explicit integration progress with attempted PR/revision and verified provider result/commit. Recheck the next target against actual refs and distinguish expected progress from unrelated changes. Changed subjects require agent assessment and refreshed affected verification; old QA is never silently relabelled. Ordinary integration progress does not consume defect-correction rounds. The initial implementation uses conservative refresh rather than a new equivalence engine. DC-36 covers these cases.

## Simplifications adopted

- **D5 is optional for the first complete multi-PR delivery.** D4 already supplies two children with one PR each. D6 can assemble/test those changes directly; general multi-output children can proceed independently.
- **Basic stacks also start from D4's single-output children.** D4b explicitly owns consumed-input revision tracking; D8 does not need general multi-output support first.
- **Deliverable submission uses the existing typed activity outcome.** No mandatory result-submission MCP tool or second terminal-result lifecycle is needed. Agent tools submit/inspect delegation; existing artifact tools retain documents.
- **Repository binding is selected registration data referencing canonical Resources and correlations.** It does not require another aggregate/resource kind.
- **Git semantic judgment stays with agents and configured QA.** Wake verifies authorized sources, revisions and declared membership. It does not require ancestry containment, which would reject valid cherry-picks/rebases, or judge whether a conflict resolution preserves intent.
- **No new supervisor, stack engine or grant registry is required.** The necessary deterministic additions enforce identity, authority, wait/phase readiness, exact revisions, bounds and recovery. Agents continue to decompose, implement, create PRs, assemble candidates, assess results and choose repair.

The useful sequence is now D1 -> D2 -> D3 -> D4 -> D6 -> D7. General multi-output D5 and basic stack work branch after D4. The first useful artifact delegation release remains D1-D3.

## Validation and limits

The independent review and bounded re-review inspected contracts and implementation; they did not run runtime tests. The earlier authoring pass ran 23 focused unit and 97 focused integration tests of the existing foundations, all passing. Those results do not cover the proposed behavior and were not rerun for these documentation-only corrections.

The final authoring pass checked UTF-8, local links/anchors, code fences, Markdown table structure, unique DC-01 through DC-36 acceptance rows, D1-D9 roadmap headings, targeted Prettier formatting and `git diff --check`. All passed. No full code verification gate, browser or E2E suite is claimed.

Remaining implementation work is the revised sequence itself. Each slice must prove its authority, recovery and surface behavior before enablement; a consistent spec is not a production guarantee. No further product decision or approval was needed to make these corrections.

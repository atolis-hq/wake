# Spec: delegated child work and coordinated delivery

**Status:** proposed, ready for review; behavior is not implemented by this document.
**Date:** 2026-10-12.
**Implementation baseline:** `d58d99154cd936b95b461c320e45b39a1b4423da`.
**Scope:** single-flow and delegated WorkItems, configurable child workflows, dependencies, repository-specific change stacks, integrated QA, correction, and recovery.

## 1. Intended outcome and recommendation

Wake should deliver one objective through either direct implementation or agent-requested child work, without requiring the workflow author to anticipate every decomposition. A parent can coordinate children across repositories; each child has its own durable identity, workflow and deliverable contract. Child work can finish before its PR is merged. The parent evaluates the combined implementation and applies configured QA, approval and integration requirements.

**Recommended approach: extend Wake's existing workflow and execution implementation.** Add typed delegation commands, independently owned child WorkItems, dependency readiness and durable joins. Expose those commands through scoped MCP tools and configured activities. Retain existing Eventing, pinned workflow definitions, runner adapters, workspace leases, delivery reconciliation and PR authority. Do not introduce LangGraph as a prerequisite.

The execution pattern is durable orchestration with agent-driven delegation: agents decide how to tackle an assignment; Wake validates, records and executes the resulting work plan. Workflow definitions remain reusable processes. Dynamic work is created by selecting allowed child workflows and recording dependencies, not by giving agents unrestricted authority to rewrite workflow definitions or launch arbitrary CLIs.

The initial delivery should prove one parent, two independent children, a deterministic join, and restart recovery in one repository. Extend that slice to six subtasks across two repositories, optional stacks, integrated QA and correction. Prompt/process refinement and existing canonical artifacts support this behavior; this spec does not prescribe a new mandatory interview stage.

## 2. Product principles

1. A WorkItem represents desired work; a workflow governs its process; a Run/session executes an attempt. Their completion states are distinct.
2. Parenthood groups responsibility. Dependencies order execution. PR stacks relate code changes. None is interchangeable with another.
3. Both upfront and incremental decomposition are supported. Known work can be queued together; discoveries can produce later children.
4. Configuration governs permitted behavior; agents choose within that authority. MCP is a transport for domain commands, not a source of workflow authority.
5. Parent coordination survives the loss of its agent session. Wake schedules children and requests parent continuation from durable facts.
6. Child success means satisfying its assigned deliverable contract. It does not imply merge, parent QA success, or overall completion.
7. Accepted evidence refers to exact artifact/change revisions. Updating a change can make prior evidence stale without deleting its history.
8. Ordinary implementation choices belong to agents. Necessary human questions are consolidated into batches; unrelated work continues when dependencies permit.
9. A small task can follow its existing single-flow workflow. Delegation is optional and should improve focus, review or recovery rather than create busywork.

## 3. Current implementation and gaps

These findings describe the baseline above, rather than the earlier architecture report's implementation snapshot.

| Existing capability                                                  | Reuse                                                               | Required extension                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Wake-owned WorkItems and descriptive `parent-of` / `child-of` links  | Identity, lifecycle, commands and event ownership                   | Validated single-parent hierarchy, independent child creation and dependency semantics                                  |
| Pinned workflow definitions, activations, waits and bounded retries  | Existing deterministic interpretation                               | Delegation and join decisions at an activity/stage boundary                                                             |
| Watch-triggered child workflows                                      | Preserve existing gate/review behavior                              | These children share the parent's WorkItem; new delegated work must have independent WorkItems                          |
| Scoped artifact MCP and revisioned content                           | Shared plans, assumptions, reports and command provisioning pattern | Policy-scoped access across related WorkItems and immutable handoff references                                          |
| Accepted artifact visibility across stages/workflows on one WorkItem | Parent-stage continuity and review context                          | Existing visibility does not automatically extend to other WorkItems                                                    |
| Optional `WorkspaceRequest.checkoutRevision`                         | Explicit Git checkout intent                                        | Current branch workspace creation does not establish delegated branch bases; implement explicit initial base resolution |
| Workspace identity includes WorkItem, mode and repository locator    | Isolated child workspaces and ownership                             | Multi-repository candidate assembly and dependency revision tracking                                                    |
| PR observations and revision-qualified merge/review policy           | Verify change facts and govern delivery                             | Logical stack membership, effective downstream invalidation and aggregate candidate acceptance                          |
| Provider pools, quota exclusions and session resumption              | Different runners per child and replacement attempts                | Preserve delegation identity and context across provider changes                                                        |
| Completion analytics derived from primary workflow completion        | Existing reporting machinery                                        | Distinguish child throughput, parent delivery and reopened readiness                                                    |

Relevant contracts and implementation: [work](../../src/work/MODULE.md), [orchestration](../../src/orchestration/MODULE.md), [execution](../../src/execution/MODULE.md), [artifacts](../../src/artifacts/MODULE.md), [workspace request](../../src/execution/contracts/workspace.ts), [watch child creation](../../src/orchestration/application/request-child.ts), [artifact provisioning](../../src/bootstrap/artifact-mcp.ts), and [completion metrics](../../src/orchestration/application/work-completion-summary.ts).

The earlier [architecture assessment](../reports/2026-10-10-architecture-recommendation-review.md) provides context and alternative options. Its historical findings must not override the current implementation baseline.

## 4. User-visible behavior

### 4.1 Direct implementation

A WorkItem can refine, receive any configured plan review, implement, receive code review, run QA, and complete or merge according to its workflow. Merely enabling delegation does not force children, change existing gates, or require a parent wrapper around every task.

### 4.2 Upfront decomposition

An authorized implementation activity submits all known children with objectives, acceptance criteria, repository targets, selected workflows, context references and dependencies. Wake returns durable child identities and the delegation receipt. It starts eligible children and represents the parent as waiting for work, not waiting for a human and not implemented successfully.

For example:

```text
Parent P: deliver a feature across repositories A and B
  A1 -> A2 -> A3   optional change stack in A
  B1 -> B2 -> B3   optional change stack in B
  A1 -> B2        example cross-repository contract dependency
```

The six children do not imply six sessions or two mandatory stacks. A child can need multiple attempts, and some children can produce investigation artifacts or standalone PRs. A stack is declared only for intentionally related code changes in one repository.

### 4.3 Incremental decomposition

An agent can delegate an investigation or initial implementation, yield, receive its accepted result, and create the next children based on what it learned. Completed work is retained. Replaying a tool request or resuming after a crash must not create duplicates.

The parent is not required to leave a CLI process running while waiting. After a durable join, Wake either requests another activity at the delegating stage or advances to the configured next stage. The workflow declares which continuation is permitted; the agent does not select arbitrary transition targets.

### 4.4 Child workflows and recursive delegation

A child selects an allowed named workflow, pinned at creation. It may use the same workflow definition as its parent or a lighter one such as implementation, focused review and deliverable submission. Children inherit the shared brief and explicit criteria; they should not independently restart discovery unless their assignment requires it.

A child can itself delegate when its workflow and scope permit that operation. Ancestry, depth and total-descendant limits are enforced durably over the delivery tree. Limits cannot be evaded by restarting a session or creating grandchildren.

Suggested workflow shapes are illustrative, not new valid configuration syntax:

```text
Parent delivery:
  refine -> plan review -> implement or delegate -> integration gate -> QA
    -> configured approval/integration -> complete

Implementation child:
  implement or delegate -> independent code review -> delivery-ready

Investigation child:
  investigate -> accepted findings

QA correction:
  assigned correction -> focused verification -> review -> updated deliverable
```

### 4.5 Human involvement

A child that needs a consequential decision records its blocker and context. A configured parent continuation or authorized human surface can respond. Known questions are batched with recommendations; answering a question does not indiscriminately approve sibling work. Parent/child relationships do not themselves grant approval authority.

## 5. Core concepts and contracts

The concepts below are semantic requirements, not a commitment to specific TypeScript type names, event names or persisted field layouts. Implementers must use owning-module vocabulary, decoders, stream validation and draft factories.

| Concept               | Required meaning                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Parent/child relation | Validated ancestry and responsibility, distinct from dependency edges                                            |
| Child assignment      | Objective, acceptance criteria, workflow, repository binding where needed, context and output requirements       |
| Delegation request    | Stable idempotency identity, originating WorkItem/workflow/activation, authorized scope and child specifications |
| Delegation cohort     | Immutable membership and join conditions for one committed request; identifies required versus optional results  |
| Dependency            | An explicit prerequisite condition referencing work or a verified deliverable                                    |
| Deliverable           | Revisioned artifact or change references with verification/review evidence and producer provenance               |
| Join receipt          | Evidence that the declared required outputs satisfy the cohort contract at a specific plan/result version        |
| Delivery candidate    | Exact repository/branch/commit and evidence references being assessed together                                   |
| Parent continuation   | Deterministically authorized resumption or advancement after join, failure or operator action                    |

Each delegated child has exactly one owning parent. Dependency references may cross siblings and repositories within the same delivery tree, but must be acyclic. Arbitrary dependencies on unrelated delivery trees are deferred initially. Self-parenting, reparenting that creates cycles and references to missing/unauthorized targets are rejected.

A parent's lifecycle is not automatically reduced to its children's lifecycle. Required child contracts and parent workflow policy determine readiness; optional children must be explicitly designated. A cancelled required child never counts as successful. Excluding it requires an authorized plan revision with an audit reason, rather than silently changing the join.

### 5.1 Stable cohort membership

One delegation request declares the children and join target for that cohort. The target does not mean "whatever children happen to exist later." Incremental creation uses subsequent cohorts after inspection of earlier results. The first slice supports one active child-wait cohort per parent workflow, matching the existing single waiting expectation model; children within it can execute concurrently.

Creating a child is not permission to finish the parent. The parent workflow remains at its delegation boundary until the cohort is satisfied or explicitly resolved. A further required cohort or revision makes any affected previously prepared delivery candidate ineligible. The final gate evaluates the current plan version and all required deliverables, including earlier cohorts.

Changes to required membership, acceptance criteria or sequencing use authorized commands with an expected plan revision. They supersede the affected cohort contract with a new version, preserving earlier membership and receipts rather than mutating a satisfied join. Existing children may be referenced by the replacement contract. Such changes reevaluate readiness and invalidate relevant candidate acceptance. Agents cannot remove requirements or required children merely to make a join pass.

### 5.2 Dependency conditions

Start with a small closed set of prerequisite meanings:

- **Result accepted:** an investigation/artifact result has satisfied its declared contract.
- **Change available:** a same-repository upstream change has a verified, remotely available branch/head revision. It need not yet be reviewed or merged.
- **Delivery ready:** required review and verification for the referenced child deliverable are satisfied at the relevant revisions.
- **Merged:** provider evidence confirms the required change is integrated. Use only where workflow policy actually requires integration before dependent work.

Names are descriptive pending contract design. Persist one direction of canonical dependency edges and derive inverse blocker views. Do not persist redundant dependency arrays whose contents can diverge.

Parenthood alone imposes no sibling execution order. Readiness combines prerequisite satisfaction, work state, workflow policy, runner eligibility and resource capacity. A known failed prerequisite exposes a reason; it does not cause endless retries or prevent unrelated eligible children from progressing.

## 6. Repository targets, branch inheritance and optional stacks

A coordinating parent can reference multiple authorized repositories. The first delivery model gives each implementation child one explicit target repository. A non-code investigation may inspect several authorized repositories; it must still produce explicit output context. Repository identity must not require inventing a GitHub issue for every internal child.

Two base-selection forms are required:

1. **Explicit base:** repository plus branch/ref, optionally an exact revision. If a branch/ref alone is submitted, Wake resolves and records its commit before dispatch.
2. **Upstream deliverable:** reference a named change output from another child. Wake waits for the required condition and resolves that output into a base branch and exact head revision.

Code inheritance is same-repository. A cross-repository dependency supplies a contract/artifact or prerequisite condition; it cannot serve as a Git base in another repository. A wrong repository, inaccessible ref, missing declared output or unauthorized target produces a specific rejection/block reason.

Initial branch creation must use the recorded base commit. Preserve the upstream branch/ref separately for PR base and retargeting behavior. Record the base resolution with the attempt and deliverable so restarts reproduce it. A retry must not silently reset an existing branch workspace or discard uncommitted changes. Ambiguous execution/side effects follow existing recovery policy before another writer is dispatched.

A child can publish a standalone PR, a stack layer, multiple explicitly named change outputs, or no PR. The first stack slice can constrain each stacking child to one designated change output while retaining a general deliverable manifest. Default PR targeting must reject ambiguous multiple outputs rather than guessing the first PR.

Agents perform ordinary Git/PR operations using a stack-aware prompt or configured activity. Wake verifies and records actual repository, base/head branches, commit revisions, PR/resource links and logical stack membership. Stack maintenance remains separate from WorkItem completion. Native stack features are optional adapter capabilities; ordinary Git branch/PR relationships provide the initial semantic slice.

### 6.1 Upstream changes and effective invalidation

Downstream evidence records which upstream outputs it consumed. A changed upstream revision makes affected downstream results and parent QA stale until they are reconciled and reverified. Previous accepted facts remain historical; effective eligibility changes. A physically completed child is not automatically rewritten into a different lifecycle state; it receives explicit corrective/refresh work or a supported new activation.

Wake must not silently rebase an actively leased workspace. A maintenance/correction activity updates branch relationships under the appropriate lease, publishes its resulting revisions and causes dependent checks to be reevaluated. In-flight QA against an older candidate can finish and retain its result, but cannot authorize a newer candidate.

## 7. Review, parent QA and final integration

A child contract can end at delivery-ready with its PR still open. Workflow completion and deliverable readiness are exposed separately from provider merge state. Internal child completion must not automatically close the parent's external issue or trigger a global merge action.

Review can be a Wake-owned agent judgment rather than a provider-native PR review. It must identify the exact change/artifact scope, reviewer provenance, verdict and outstanding findings. Independent reviewer requirements remain configuration policy. Artifact publication or an agent's completion claim does not alone prove acceptance. Existing provider review/merge checks remain authoritative where a workflow requires them; an internal verdict does not impersonate an external approval.

The parent integration gate assembles a candidate manifest from current required outputs. It verifies join membership, declared dependency conditions, review/check freshness and repository/change relationships before requesting QA. A candidate can consist of two stack heads, one per repository, plus plan and evidence revisions. It need not be merged into each repository's main branch before testing.

Several standalone child changes in one repository require a configured candidate-assembly activity to combine their pinned heads in a disposable integration workspace. Record the resulting candidate revision and every contributing change revision. Conflicts become explicit corrective work. Do not assume the last child's branch contains earlier independent changes. Assembly uses its own lease and cannot rewrite child branches; QA then checks out the recorded combined revision.

The QA activity receives isolated checkouts at those exact revisions, a configured test/environment recipe, and overall acceptance criteria. It returns evidence for that candidate. If the environment or revision is unavailable, QA reports that operational blocker rather than asserting success. Automatic generation of arbitrary deployment environments is outside scope.

Early shared-interface checks are permitted and encouraged; full QA remains the final combined verification. Cross-repository integration is not an atomic Git operation. Workflows must describe compatible integration order or deployment prerequisites; this feature does not promise atomic multi-repository merges or rollback.

On QA findings, policy can resume the delegating implementation stage or authorize corrective children referring to the affected prior deliverables. The initial default creates a corrective child when the original child/workflow is already terminal; it does not assume completed primary claims can be silently reopened. An existing non-terminal child can receive a supported correction activation. Relevant candidate evidence becomes stale. Automatic correction/review rounds consume configured budgets scoped to the appropriate delivery/assignment; new children and provider switches do not reset those budgets. Exhaustion produces an inspectable escalation with unresolved findings, not an unbounded loop.

Parent completion occurs only after current required deliverables, QA and configured approval/integration gates are satisfied. Workflows that stop at QA-approved need not merge; workflows requiring merge do not complete merely because QA passed. Freeze/dispatch pause, operator consent and merge restrictions apply throughout.

## 8. MCP, configuration and execution

### 8.1 Agent-facing commands

Provide typed operations to submit a child cohort, inspect delegated work/results and submit a revisioned deliverable. Corrections and plan amendments use narrowly authorized domain commands. Exact tool names and schemas are implementation decisions; use the established MCP naming and provisioning conventions.

A delegation submission includes stable request identity, local child keys for within-batch references, objectives/criteria, selected workflow, repository binding, required/optional designation, prerequisites, base request and artifact context references. Wake supplies trusted parent, actor, Run, activation and authority context from the issued capability. Tool arguments cannot manufacture that authority.

Expose no arbitrary `transitionTo`, raw event append or provider session-spawning operation. A request for execution characteristics must resolve through configured policies and runner pools. A child may use a different provider/model from siblings and parent. Quota fallback or session replacement preserves child/cohort identity and reassembles durable context; it must not duplicate work or transfer one provider's opaque session ID to another.

### 8.2 Configured behavior

Configuration declares allowed child workflows/repositories, delegating stages/activities, depth/descendant/concurrency limits, permitted mutation classes, join/continuation behavior, output requirements and review/QA/integration gates. Exact keys are proposed during implementation with strict schema and compiler checks.

Static configured delegation and dynamic MCP delegation call the same application commands. A predictable stage can start configured child work without asking an LLM to choose the process. An enabled implementation stage can choose direct execution or permitted delegation. A configured child profile can end at delivery-ready rather than merge, independently of the parent profile.

Use dependency-based eligibility as the default ordering rule. Allow an explicit serial policy for a parent or stack where useful. Do not emulate parent-local serial execution by globally reducing all of Wake to one concurrent Run. Independent repositories may progress concurrently within limits.

### 8.3 Delegation is not a normal success outcome

A recorded delegation produces a receipt consumed through an owning-module contract. The stage enters a durable child wait/yield state with its configured continuation; it must not route through ordinary implementation success while required children are incomplete. Missing, malformed or unauthorized receipts cannot manufacture a wait or approval.

After join, Wake emits/consumes a durable continuation once per relevant plan version. The configured continuation can request the parent agent to inspect results and create the next cohort, or advance to integration/QA. Inspection tools return immediately with current state; waiting belongs to orchestration rather than a long-running MCP call keeping a CLI alive.

## 9. Artifacts, context and authority

Reference exact artifact revisions/digests for the shared brief, acceptance criteria, plans, assumptions, child findings and QA reports. Parent/child WorkItems remain distinct owners; do not copy context bytes into a second canonical conversation or graph store.

Provide explicit immutable cross-WorkItem artifact read grants: child reads approved parent context; parent reads declared child deliverables; QA reads candidate evidence. Siblings receive only required shared/upstream context. Writes remain producer-owned. Review independence rules can restrict implementation transcripts while still granting required specification/change evidence.

Artifact publication and evidence acceptance remain separate. Unaccepted drafts from interrupted attempts need an explicit recovery/handoff grant if required, carrying draft status and original provenance. Changing a shared brief/criterion revision triggers relevant plan/evidence reevaluation rather than silently changing every child's contract.

Delegation credentials are scoped to parent/child ancestry, authorized repository/workflow choices, mutation classes, and current Run/activation. Existing expiry/revocation behavior applies. An identity in `CommandContext` is audit provenance, not sufficient authorization by itself. Operator consent, required human review and final merge authority are never broadened by delegation.

## 10. Persistence, concurrency and recovery

Use module-owned typed events, optimistic concurrency and stable command/request identities. All new facts must be decoded before folding; projections remain rebuildable. Existing watch provenance and same-WorkItem child semantics remain intact and must not be reinterpreted as independent child work.

Creation spans several aggregates. Record a durable delegation intent/claim and reconcile child WorkItem creation, repository binding, context grants and workflow start idempotently. Do not assume a transaction across journal streams. A child becomes dispatchable only after its required registration facts are complete. Expose incomplete registrations and recover them; replay must neither drop nor duplicate children.

Use the owning parent's delivery/plan revision to serialize concurrent graph mutations and cycle checks. A stale mutation receives a typed conflict and can be reconsidered against current state. Depth and budget claims must remain correct when multiple authorized requests race.

Parent wait registration and child result consumption must handle either event ordering. A child that finishes before the parent fully registers its wait still contributes its recorded result. A join claim/receipt prevents duplicate parent continuation. Retained delivery candidates and artifact references must remain inspectable after restart and workspace cleanup.

Cancellation stops dispatch of newly ineligible required descendants and cancels active work under existing execution policy. Freeze prevents new work/mutations in the frozen subtree; already running work may finish according to existing freeze semantics, but cannot cause a frozen parent to advance. A child cancellation/failure exposes an unsatisfied prerequisite and parent blocker, while unrelated branches continue where policy permits.

## 11. Module ownership and recommended implementation seams

| Module          | New or extended responsibility                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `work`          | Validated hierarchy, canonical work dependencies/criteria, graph mutation rules and lifecycle facts                    |
| `resources`     | Explicit repository bindings, external change identity/correlations and verified provider observations                 |
| `orchestration` | Allowed child profiles, delegation/cohort claims, wait/join/continuation semantics and workflow-derived delivery gates |
| `activities`    | Typed delegation/deliverable outcomes, code-review judgments and QA activities; existing PR authority                  |
| `execution`     | Workspace base resolution, attempt provenance, leases, pinned candidate checkouts and provider-independent attempts    |
| `control-plane` | Eligibility and dispatch respecting dependencies, freeze, quotas and per-delivery capacity                             |
| `artifacts`     | Related-work revision read grants, retained provenance and explicit recovery access                                    |
| `integrations`  | PR/stack observation and delivery, external verification and idempotent reconciliation                                 |
| `surfaces`      | Work tree, dependency/blocker views, delegation tools and operator controls via public applications                    |
| `bootstrap`     | Compose domain applications/ports, processors, scoped capabilities and concrete adapters                               |

Keep repository/provider payloads out of `work`. Compose cross-module registration through typed ports and Bootstrap; extend declared dependencies only where acyclic ownership requires them. New children normally start their own primary workflow rather than using the watch-child startup path that requires the same WorkItem as the parent.

The narrow seams are delegation request/receipt, dependency readiness, revisioned deliverable, join result and parent continuation. Reuse the existing engine around these. Do not implement a second generic graph scheduler or a new agent loop. A later LangGraph comparison should demonstrate actual deletion of generic execution machinery and parity for these contracts before adoption.

## 12. Alternatives and behavioral trade-offs

| Alternative                                        | Benefit                                                            | Limitation / decision                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Expand static workflows for every decomposition    | Predictable configured paths                                       | Requires anticipating discoveries; retain for repeatable child profiles, not every possible task topology               |
| Parent agent manages native CLI subagents directly | Fast local delegation and shared reasoning                         | Durable work contracts, provider replacement and external-event progression remain unclear unless recorded through Wake |
| Agent-authored executable workflow scripts         | Flexible sequencing and result propagation                         | New process authority/replay boundary; not required for the initial bounded delegation model                            |
| LangGraph executor                                 | General subgraphs, durable execution and joins                     | Does not supply Wake's work/change/acceptance semantics; replacement benefit needs a parity/deletion demonstration      |
| Extend Wake with durable child work                | Keeps governance and session independence while allowing discovery | Decomposition can fragment shared decisions; canonical context and integrated QA are necessary                          |

Do not force each checklist step or PR into a separate WorkItem. A child is useful where separate execution, review or recovery has value. Tightly coupled stack layers can belong to one repository-level child with named outputs. Serial execution simplifies coordination but delays independent work; concurrency policy should follow dependencies. Parent QA adds coherence but cannot substitute for early interface checks or revision-qualified child review.

## 13. Acceptance scenarios

Scenario labels below are proposed acceptance references, not registrations in the existing catalogue. Delivery issues must add appropriate catalogue/scenario coverage as their behavior becomes implemented.

| ID    | Observable acceptance                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC-01 | Existing single-flow work completes through its configured gates without creating children                                                                                       |
| DC-02 | Upfront request creates two independent children, queues prerequisites and returns stable IDs                                                                                    |
| DC-03 | Replayed request after lost tool response returns the same children; no extra workflow or consent facts appear                                                                   |
| DC-04 | Incremental delegation resumes the parent after an investigation and creates later implementation children using its exact accepted findings                                     |
| DC-05 | Children use different allowed workflows/providers; disallowed workflows/repos/mutations are rejected before dispatch                                                            |
| DC-06 | Child WorkItem identity differs from the parent; existing watch-child review gates retain their previous behavior                                                                |
| DC-07 | Self-dependency, hierarchy/dependency cycles, missing targets and stale plan revisions produce typed rejections/conflicts                                                        |
| DC-08 | Depth/descendant/correction limits survive restart and concurrent requests; grandchildren cannot bypass them                                                                     |
| DC-09 | A valid child result arriving before wait registration is consumed once; duplicate events do not resume the parent twice                                                         |
| DC-10 | A required child failure/cancellation blocks the relevant join, optional exclusion is explicit, and an independent branch can continue                                           |
| DC-11 | Explicit branch base resolves to a recorded commit; unavailable or wrong-repository bases expose an actionable reason                                                            |
| DC-12 | Child B starts from child A's verified pushed change before merge when configured; merged prerequisites wait for actual merge evidence                                           |
| DC-13 | Six implementation tasks across two repositories can form two declared stacks, with a cross-repository contract dependency and independent progress                              |
| DC-14 | A non-code child and standalone PR child complete without stack membership                                                                                                       |
| DC-15 | Child finishes with required review/check evidence while its PR remains open; parent external issue remains open                                                                 |
| DC-16 | QA receives exact repository revisions and shared criteria, including assembled independent changes when required; testing main or a different candidate cannot satisfy the gate |
| DC-17 | Upstream change makes affected downstream review/QA stale; unrelated evidence remains effective                                                                                  |
| DC-18 | QA findings create/resume permitted corrective work and repeat verification within budgets                                                                                       |
| DC-19 | A frozen/cancelled parent does not advance or dispatch new descendants through a late completion event                                                                           |
| DC-20 | Parent/child context grants permit required artifact reads, deny unrelated work/draft reads and preserve producer-only writes                                                    |
| DC-21 | Quota fallback, unavailable session and Wake restart preserve child/cohort/base/result identity; ambiguity is reconciled before redispatch                                       |
| DC-22 | Interrupted partial registration recovers without making an incomplete child executable                                                                                          |
| DC-23 | Operator sees tree, workflow, repository, base, prerequisites, join status, stale evidence and reason for any block                                                              |
| DC-24 | QA-approved-only parent can finish without merge; merge-required parent remains incomplete until integration gates are met                                                       |
| DC-25 | Completion metrics distinguish accepted child deliverables from final parent delivery and show corrective activations without duplicate delivery counts                          |

Use pure domain/unit tests for decisions and composed fake integration tests for registration, dispatch, artifacts, delivery and recovery. Workspace/base and stack tests require real Git filesystem fixtures and fake providers. Focused process/filesystem E2E fixtures run serially. Surface changes need relevant API/web tests. No live model tokens are required to prove orchestration correctness; a later bounded agent trial evaluates decomposition and prompt behavior separately.

## 14. Delivery slicing into issue-ready work

These are proposed issue bodies, not filed or dispatched GitHub issues. Each has an outcome independent of its suggested approach. Before filing, choose assignment/labels according to repository dispatch instructions; unattended items should use the dark-factory task template. Each implementation slice must update current reference docs when it changes config/CLI/API behavior and run focused coverage plus `npm run verify:agent` before PR handoff.

### D1. Validated child work and prerequisite contracts

**Intended outcome:** independently owned child WorkItems have validated ancestry, criteria and prerequisite meaning that survive replay.

**Acceptance:** DC-02, DC-06, DC-07 and hierarchy/budget groundwork for DC-08. Prove child creation/link idempotency, acyclic mutations, required/optional designation and no changed legacy watch semantics. Existing single-flow contracts remain valid.

**Dependencies:** none. **Constraints:** no provider/session authority in Work; no duplicate canonical graph. **Suggested approach:** extend Work's public commands/events/fold and use a parent/plan revision for concurrent mutations; define output/prerequisite vocabulary before scheduling.

### D2. One-repository delegation, durable wait and join vertical slice

**Intended outcome:** a composed activity can delegate two children using existing workflows and the parent continues exactly once after required deliverables satisfy its join.

**Acceptance:** DC-01 through DC-04, DC-09, DC-10 and DC-22 with deterministic composed fakes. Kill/restart during registration and around parent wait; never duplicate or lose children. Parent stage does not advance via ordinary success while waiting.

**Dependencies:** D1. **Constraints:** no LangGraph replacement; children each start an independent primary workflow. **Suggested approach:** typed delegation receipt, stable cohort claim, idempotent registration reconciler and event-driven join. Prove this first with workspace-free result/artifact children and permanent composed fakes; actual delegated code workspaces arrive in D4/D5. Existing repository context may accompany the assignment, but this slice must not invent primary issue correlations to make internal children executable.

### D3. Scoped MCP/config delegation and bounded recursion

**Intended outcome:** authorized agents and configured activities call the same delegation commands, select permitted child profiles and can inspect their results without managing CLI sessions.

**Acceptance:** DC-05, DC-08 and DC-19; actual run-scoped MCP lifecycle coverage. Prove expired/revoked credentials, wrong-parent requests, consent escalation, depth races and retry identity handling. Ordinary direct implementation remains supported.

**Dependencies:** D2. **Constraints:** server-issued authority; agents cannot choose arbitrary stage transitions/providers. **Suggested approach:** extend current Wake MCP provisioning with distinct capabilities, strict config/compiler validation and repeatable fake agent tool calls. Document new configuration/tool behavior.

### D4. Repository targeting and pinned inherited branch bases

**Intended outcome:** internal child work selects an authorized repository and starts from an explicit base or an upstream deliverable, without requiring a child GitHub issue.

**Acceptance:** DC-11 and DC-12; two-repository workspace fixtures; retries preserve existing changes and leases. Cross-repository dependencies cannot become Git bases. Record both logical base ref and resolved commit.

**Dependencies:** D2; agent-facing exposure also uses D3. **Constraints:** infrastructure remains in Execution/Integrations, not Work. **Suggested approach:** repository binding port, typed base intent/resolution and branch-workspace initialization using verified remote revisions. Reuse current checkout/lock/recovery mechanisms.

### D5. Related-work artifact handoff and revisioned deliverables

**Intended outcome:** parents, children and independent reviewers receive exactly the shared context/results they need, and delivery readiness refers to verified revisions rather than prose or publication alone.

**Acceptance:** DC-15, DC-20 and DC-21 context continuity; related-work grants, unpublished-draft isolation and scoped recovery. An agent judgment can be accepted internally without manufacturing a native PR approval. Parent acceptance checks current required reviews.

**Dependencies:** D2 and D3; code-change manifests use D4. **Constraints:** preserve producer-owned writes and canonical artifact/resource identity. **Suggested approach:** immutable read grants, typed result manifest and explicit evidence acceptance; no duplicate byte store.

### D6. Optional repository stacks and effective dependency invalidation

**Intended outcome:** stacked and standalone child changes coexist; Wake records stack relationships, resolves downstream readiness and invalidates affected evidence after upstream changes.

**Acceptance:** DC-12 through DC-14 and DC-17; two repository stacks, downstream update after upstream correction, ambiguous PR-output rejection and no writes into actively leased workspaces. Independent work remains eligible.

**Dependencies:** D4 and D5. **Constraints:** delegate Git mechanics through existing tools/adapters; no full generic stacking engine. **Suggested approach:** stack-aware prompt/activity plus verified change manifests, revision-consumption records and explicit refresh/correction scheduling.

### D7. Parent candidate QA and bounded correction

**Intended outcome:** a parent verifies the exact combined unmerged implementation, repairs defects through its permitted process, and completes only at its configured QA/approval/integration boundary.

**Acceptance:** DC-16, DC-18 and DC-24; two candidate revisions, two standalone changes assembled in one repository, a late stale QA result, correction-loop exhaustion and a successful rerun. Parent QA can happen while child PRs remain open. QA environment failures remain operational blockers.

**Dependencies:** D5; multi-repository stack scenario also uses D6. **Constraints:** no atomic cross-repository merge promise; do not reopen external issues based solely on internal child state. **Suggested approach:** candidate manifest, read-only pinned checkouts, configured QA recipe, typed findings and parent continuation choices under existing budgets/merge authority.

### D8. Operator views and delivery metrics

**Intended outcome:** operators can inspect and control delivery trees, dependency blockers, candidates and stale evidence, while reporting separates child work from final parent delivery.

**Acceptance:** DC-23 and DC-25 plus surface coverage for freeze/cancel/retry and permission/conflict responses. Waiting for children is distinguishable from waiting for a human. Links identify artifacts, branches and PRs at their relevant revisions.

**Dependencies:** D2 for initial tree/blockers; D6/D7 for stack/candidate panels. **Constraints:** surfaces use public applications/projections and define no domain events. **Suggested approach:** additive DTOs/presenters, rebuildable delivery projections, focused board/detail views and derived metrics.

### D9. Recovery, concurrency and complete delivery proof

**Intended outcome:** the composed production path delivers six subtasks across two repositories, survives process/provider interruptions, and preserves current authority/gates through QA and correction.

**Acceptance:** all DC scenarios relevant to the final slice, especially DC-03, DC-08 through DC-10, DC-17 through DC-22. Crash between each registration/join boundary, race plan updates, change an upstream head during QA and exercise quota fallback. No live model spend is needed for the correctness suite.

**Dependencies:** D3 through D8. **Constraints:** recovery coverage is part of every earlier slice; this is final combined fault proof, not permission to defer correctness. **Suggested approach:** permanent composed fakes, real Git fixtures, failure injection at adapter boundaries, focused serial E2E and documented operating limits.

### Sequencing and release points

```text
D1 -> D2 -> D3
       |     |
       +---> D4 -> D5 -> D6 -> D7
       +--------------------> D8
                      D3..D8 -> D9
```

The dependency descriptions above are authoritative; the diagram is a summary. D5 can develop its non-code artifact portion after D2/D3 while D4 supplies code manifests. D8 should expose useful basic tree/blocker visibility at the first delegation release, then expand as later slices land.

Release one: D1-D3, basic D8 and slice-local recovery, for direct work plus delegated investigation/result work. Delegated code delivery follows D4/D5. Release two: D4-D7, expanded D8 and D9, for multi-repository candidates and optional stacks. Defaults keep existing workflows unchanged; opt in selected profiles before wider rollout.

## 15. Rollout, evaluation and decisions reserved for implementation

Success measures include correct overall completion, avoidable human interruptions, time blocked by prerequisites, review/QA correction convergence, duplicate dispatch/registration count, restart recovery and provider allowance use. Fewer sessions or questions are not success if incorrect work passes the gates.

This spec chooses existing-engine extension, both delegation modes, immutable per-request join cohorts, one target repository per implementation child, explicit revision-based inheritance, optional stacks and configurable final integration. Exact public vocabulary, strict schema keys, event stream layouts, limits/default values and QA fixture recipes must be designed in their owning modules. Those decisions must preserve the behavioral requirements and be made reviewable in the relevant delivery issue.

Deferred: arbitrary workflow code generated by agents; general cross-delivery dependencies; automatic deployment environment synthesis; atomic multi-repository merge/rollback; a standalone session product; a generic plugin framework; mandatory ACP/LangGraph/Devin dependencies. These can be considered when a concrete use case requires them.

Before each rollout, verify historical event decoding/replay, legacy watch gates, current single-flow execution, artifact permissions and existing PR authority. Do not migrate descriptive relations into executable prerequisites or reinterpret existing same-WorkItem child facts implicitly.

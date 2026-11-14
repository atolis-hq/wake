# Spec: delegated child work and coordinated delivery

**Status:** proposed; refined against current main. Existing capabilities and proposed extensions are distinguished below.
**Date:** 2026-10-18.
**Reviewed implementation:** `25ef4657d2f1eda6e66b0282d09672cc053d6d89` (`origin/main`, fetched before review).
**Original baseline:** `d58d99154cd936b95b461c320e45b39a1b4423da`.
**Scope:** single-flow and delegated WorkItems, configurable child workflows, dependencies, repository-specific change stacks, integrated QA, correction, and recovery.

## 1. Intended outcome and recommendation

Wake should deliver one objective through either direct implementation or agent-requested child work, without requiring the workflow author to anticipate every decomposition. A parent can coordinate children across repositories; each child has its own durable identity, workflow and deliverable contract. Child work can finish before its PR is merged. The parent evaluates the combined implementation and applies configured QA, approval and integration requirements.

**Recommended approach: extend Wake's existing workflow and execution implementation.** Add typed delegation commands, independently owned child WorkItems, dependency readiness and durable joins. Expose those commands through scoped MCP tools and configured activities. Retain existing Eventing, pinned workflow definitions, runner adapters, workspace leases, delivery reconciliation and PR authority. Do not introduce LangGraph as a prerequisite.

**Responsibility rule: Wake prepares the work; agents act.** Wake prepares assignments, authorized context, repository/base checkouts and execution constraints. Agents choose decomposition, investigate, implement, commit, push, create PRs, maintain stack branches, review results and decide how to correct defects. Wake verifies reported external facts, records durable results, enforces configured gates and schedules permitted follow-up work. PR creation is agent activity, including in multi-PR and stacked delivery. Existing configured approval/merge activities remain available under their current authority; this design adds no automatic PR creation or new default merge authority.

The execution pattern is durable orchestration with agent-driven delegation: agents decide how to tackle an assignment; Wake validates, records and executes the resulting work plan. Workflow definitions remain reusable processes. Dynamic work is created by selecting allowed child workflows and recording dependencies, not by giving agents unrestricted authority to rewrite workflow definitions or launch arbitrary CLIs.

The recommended first complete release proves parent delegation to ordinary multi-stage children, reviewed PRs and an intentional stack in each of two repositories, parent assessment and the configured final delivery boundary. Artifact-only children remain useful fixtures, not a separately required product release before code work. Build the final assignment and named-output contracts from the start, then progressively enable dependency scheduling, bounded nesting, parent attention and governed integration. Do not build temporary product restrictions or an artifact-only intermediate release. Prompt/process refinement and existing artifacts support this behavior without a mandatory interview stage.

**Release scope:** sections 4-13 describe the full target behavior and its correctness constraints. The [scope review](../reports/2026-10-18-delegated-child-work-scope-review.md) records simplification options considered. The subsequently agreed [section 14](#14-agreed-progressive-delivery-sequence) keeps the target as the aim and removes interim restrictions that would add migration work. A target concept is not automatically a first-release service, schema or prerequisite. Unsupported later options must be rejected explicitly. Existing review/approval policy, exact revision checks and recovery are never optional shortcuts.

The companion [delivery oversight spec](delivery-oversight.md) proposes a narrow earlier increment for choosing work against available capacity and an optional delivery focus. Oversight selects across deliveries; this spec coordinates execution within a delivery. Triggers, shared memory and the configured oversight workflow are now implemented independently of delegated work. Their existing contracts should be reused; the companion spec records their design history, while the code and current reference docs establish current behavior. Once hierarchy exists, children share their root delivery's open-work accounting while retaining their own workflow and dependency readiness. Any future portfolio preference also belongs to the root; this design does not add one.

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

These findings describe the reviewed main revision. The historical report and the companion spec's original O1-O5 issue sequence are rationale, not a backlog of still-missing prerequisites.

| Capability                    | Implemented on main                                                                                                                                                                                                                  | Remaining for delegated delivery                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work identity and links       | Wake-owned WorkItems, objectives/tags, lifecycle, consent, freeze and descriptive `parent-of` / `child-of` links                                                                                                                     | Single owning parent, root identity, criteria, canonical prerequisite edges, cycle checks and tree-scoped mutation/budget serialization. `link` currently updates only the source item and does not validate the target/hierarchy.                                                                                                                                |
| Workflow execution            | Pinned definitions, independent primary workflow claims, activations, one wait, watches, retries, fresh watch review and operator continuation                                                                                       | Child registration across distinct WorkItems, delegation yield, exact cohort join and configured parent continuation.                                                                                                                                                                                                                                             |
| Watch children                | `RequestChild` starts a workflow on the parent's **same WorkItem**, with watch provenance and bounded group claims                                                                                                                   | Preserve it. It is not the independent-child startup path; delegated children get their own primary claims.                                                                                                                                                                                                                                                       |
| Local artifacts               | Revisioned bytes, producer-owned writes, accepted-activation visibility across stages/workflows on one WorkItem, run-scoped MCP credentials                                                                                          | Typed assignment/result use of exact revisions; an accepted activation alone does not establish a passing review or successful deliverable.                                                                                                                                                                                                                       |
| Named artifact contexts       | Explicit `contextScope`, trusted trigger enrollment, selected successful exports, `memory.md` pointer with expected-prior checks, local-plus-shared reads                                                                            | Reuse unchanged. No implicit root-delivery scope, child enrollment, scope registry or writable shared namespace.                                                                                                                                                                                                                                                  |
| Artifact delegation substrate | `ArtifactDelegationGrant`, `registerChild`, selected `childReferences`, accepted `parentReferences`, directional reads, no inferred sibling access; unit coverage exists                                                             | No production caller of these delegation methods. Wire validated registration and per-run grants into MCP. Pin result references for joins; `parentReferences` discovers latest accepted output and is not itself an immutable result receipt. Draft recovery grants remain missing.                                                                              |
| Operator context              | Named-scope operator instructions, separate trusted provenance, captured per-run revision including absence, read-only MCP snapshot                                                                                                  | Do not convert these into agent artifacts or implicitly inherit trigger instructions/scope through ancestry. Ordinary child assignment context uses explicit references.                                                                                                                                                                                          |
| Triggers and oversight        | Explicit cron/events, durable single-flight/coalescing, pause, manual Run now, retries/recovery, diagnostics/UI, scoped memory and configured dependency-aware triage via `gh`                                                       | None is a prerequisite to rebuild. Trigger invocation WorkItems may later delegate; extend origin lookup/self-source suppression to their descendants. Agent triage is not deterministic native dependency enforcement.                                                                                                                                           |
| Capacity and priority         | `maxConcurrentRuns`, `maxDispatches`, runner pools/quotas, `maxOpenWorkItems` (started nonterminal WorkItems; default unlimited), remaining-agent-step/watch/retry ordering                                                          | Count a registered delivery tree once for open-work capacity. Apply dependency eligibility and a root run cap before existing priority. No new portfolio preference/fairness policy is implied.                                                                                                                                                                   |
| Repositories/workspaces       | Repository Resources and explicit correlations; workspace identity includes WorkItem, mode and locator. Read-only `checkoutRevision` is supported                                                                                    | Current execution selects one resource by kind precedence; branch creation ignores `checkoutRevision`. Add explicit child repository binding and recorded initial base, rather than passing a bag of repositories or fabricating an issue. Multi-checkout candidate preparation is also missing.                                                                  |
| PRs and external publication  | Agents report PRs; Integrations verifies/registers claims. Explicit PR resource targets and ambiguous-default rejection, exact-head review/check authority, merge delivery/reconciliation, conflict/closed-PR recovery already exist | Named multiple outputs, aggregate joins, stack/base consumption and candidate evidence. Existing registration verifies claims against the recorded Run workspace branch; different output branches need explicit per-output verification provenance. Keep one primary WorkItem per PR; the parent references child PRs without taking their primary correlations. |
| Analytics                     | Work throughput plus usage, duration, repository and runner-pool reports exist                                                                                                                                                       | Independent children would currently count as primary completions. Add root-delivery versus child-result reporting and correction provenance, without rebuilding run analytics.                                                                                                                                                                                   |

Inspected public surfaces and implementation:

- [Work commands/service](../../src/work/application/work-service.ts), [workflow configuration](../../src/orchestration/contracts/config.ts), [watch child creation](../../src/orchestration/application/request-child.ts), and [workflow views](../../src/orchestration/contracts/views.ts).
- [Artifact context contracts](../../src/artifacts/contracts/context.ts), [context service](../../src/artifacts/application/artifact-context-service.ts), [trigger context wiring](../../src/bootstrap/artifact-trigger-context.ts), and [MCP provisioning](../../src/bootstrap/artifact-mcp.ts).
- [Trigger configuration](../../src/control-plane/contracts/config.ts), [open-work policy](../../src/control-plane/domain/open-work-policy.ts), [workspace selection](../../src/execution/application/execution-validation.ts), and [Git workspace implementation](../../src/execution/infrastructure/workspace/git-workspace.ts).
- [PR targets](../../src/activities/pr/contracts.ts), [PR authority](../../src/activities/pr/policy.ts), [external artifact registration](../../src/integrations/application/artifact-registration-reactor.ts), and [completion metrics](../../src/orchestration/application/work-completion-summary.ts).

The [historical architecture review](../reports/2026-10-10-architecture-recommendation-review.md) informs the alternatives and autonomy boundary; it does not establish current implementation status.

Module manifests/public indexes and relevant contracts were read for Work, Resources, Artifacts, Activities, Orchestration, Execution, Control Plane, Integrations and Bootstrap. No runtime behavior is added by this document.

## 4. User-visible behavior

### Expected flows at a glance

| Flow                                    | Agent activity                                                                                                             | Wake interaction                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct task                             | One agent implements/reviews through the configured workflow.                                                              | Existing workflow, workspace, artifact and PR mechanisms. No children.                                                                                    |
| Delegate and collect                    | Parent asks for children; each child investigates or implements and returns outputs; parent assesses the combined results. | Register assignments, prepare context/workspaces, dispatch ordinary workflows, wait durably and resume the parent once the required results qualify.      |
| A child needs help                      | Child reports a blocker; parent assesses the batch and supplies context or escalates necessary human questions.            | Coalesce parent attention and scoped replies without satisfying the join; independent children continue within authority and capacity.                    |
| Combined QA and correction              | An agent assembles a candidate; QA tests it; parent chooses any required repair.                                           | Prepare/check exact inputs and retained candidate checkouts; record outcomes and enforce configured gates/budgets. Agents create PRs and perform repairs. |
| Optional stack or multiple repositories | Agents work in the selected repositories and may create dependent branches/PRs.                                            | Resolve explicit bases/prerequisites, prepare the right checkouts and flag evidence affected by changed inputs. No automatic rebasing or PR creation.     |

Parent-to-child handoff is the **assignment plus selected context references**. Child-to-parent handoff is the **ordinary result plus exact output references**. Wake carries execution identity, durable waiting and authority through its existing mechanisms; it does not ask agents to exchange all the implementation metadata in section 5.3 themselves.

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

The parent agent selects an allowed named workflow for each child, pinned at creation. The child runs it as an ordinary independent primary workflow: it needs no parent-specific join stage, parent callback or embedded delegation protocol. It may use the same definition as the parent or a lighter one. A full multi-stage workflow is valid, for example plan -> plan review -> implement -> code review -> agent opens PR -> delivery-ready. Existing workflows are reusable when their required resources/inputs are available and their completion/output policy fits the assignment; an issue-only or automatically merging workflow is not silently converted into an internal delivery-ready child.

The parent passes one durable assignment when requesting the child: objective/criteria, selected artifact references, repository, starting ref/commit and intended PR base, plus prerequisites where needed. Wake makes that assignment available in each activity's ordinary input/prompt context. Activities retain their existing configured `with` inputs; a new generic variable language or mutable global variables are unnecessary. Plan and review stages exchange artifacts through the child's existing local artifact namespace. The implementation stage creates its branch from the recorded starting commit. Plan review reads the exact plan revision; code review reads the child's implemented head and evidence, not its original starting base. The branch/PR and output revisions evolve through ordinary stage outcomes while the original assignment/base remains recorded.

A branch-only request means resolve and record its head before dispatch, not follow whatever is latest independently at every later stage. If the upstream source changes during planning/review, Wake detects the affected consumed revision and requests assessment; agents decide whether and how to refresh under the existing lease rules. Children receive the selected shared brief and explicit criteria rather than independently restarting discovery unless their assignment requires it.

**Bounded nesting:** a child can itself delegate when its workflow and scope permit that operation. Depth one remains the default operating policy; the contracts and implementation support explicitly configured deeper trees. Ancestry, depth and total-descendant limits are enforced durably over the delivery tree. Limits cannot be evaded by restarting a session or creating grandchildren.

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

The concepts below describe full-target responsibilities, not nine new services or aggregates. Use immutable required-child batches, recorded assignments/named outputs and durable continuation, extending declared prerequisites and bounded nesting through the section 14 sequence. Optional membership and arbitrary plan editing remain unscheduled follow-ons. A cohort is the membership of one committed delegation request; its receipt can also identify the join. A delivery candidate is a typed manifest of revisions, not a new work lifecycle. Reuse WorkItems as assignments and Runs as attempts. Implementers must use owning-module vocabulary, decoders, stream validation and draft factories.

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

Each delegated child has exactly one owning parent. Initially attach only newly created, server-identified children; defer adoption and reparenting of existing WorkItems. Legacy descriptive links never establish this executable relationship. Dependency references may cross siblings and repositories within the same delivery tree, but must be acyclic. Arbitrary dependencies on unrelated delivery trees are deferred initially. Self-parenting, reparenting that creates cycles and references to missing/unauthorized targets are rejected.

A parent's lifecycle is not automatically reduced to its children's lifecycle. Required child contracts and parent workflow policy determine readiness; optional children must be explicitly designated. A cancelled required child never counts as successful. Excluding it requires an authorized plan revision with an audit reason, rather than silently changing the join.

### 5.1 Stable cohort membership

One delegation request declares the children and join target for that cohort. The target does not mean "whatever children happen to exist later." Incremental creation uses subsequent cohorts after inspection of earlier results. Use one unresolved cohort per parent workflow and the existing one-active-activation/wait model. Children may execute concurrently; item 5 serializes parent attention with the successful join without adding a second active parent lane.

Creating a child is not permission to finish the parent. The parent workflow remains at its delegation boundary until the cohort is satisfied or explicitly resolved. A further required cohort or revision makes any affected previously prepared delivery candidate ineligible. The final gate evaluates the current plan version and all required deliverables, including earlier cohorts.

**Later general-amendment extension:** changes to required membership, acceptance criteria or sequencing use authorized commands with an expected plan revision. They supersede the affected cohort contract with a new version, preserving earlier membership and receipts rather than mutating a satisfied join. Existing children may be referenced by the replacement contract. A permitted technical correction can replace an affected output with a corrective child's output while preserving its original acceptance criteria; this is an audited plan amendment, not removal of a requirement or a reason for another human approval by default. Such changes reevaluate readiness and invalidate relevant candidate acceptance. Agents cannot remove requirements or required children merely to make a join pass.

### 5.2 Dependency conditions

**First core:** the parent requests a downstream batch only after the needed upstream child has completed and its exact output is available. That output can remain unmerged. The parent passes its recorded repository/ref/commit and selected artifacts explicitly. This supports stacks and cross-repository contract handoff without queued dependency edges or four-phase readiness scheduling. Upfront batches contain independently ready children. The vocabulary below is a later optimization for queuing dependent work in advance.

The agent declares actual prerequisites; Wake does not infer them from prose, file overlap, PR order or parenthood. Add the following closed conditions as the relevant slices land (the first artifact slice needs only result acceptance):

- **Result accepted:** an investigation/artifact result has satisfied its declared contract.
- **Change available:** a same-repository upstream change has a verified, remotely available branch/head revision. It need not yet be reviewed or merged.
- **Delivery ready:** required review and verification for the referenced child deliverable are satisfied at the relevant revisions.
- **Merged:** provider evidence confirms the required change is integrated. Use only where workflow policy actually requires integration before dependent work.

Names are descriptive pending contract design. Persist one direction of canonical dependency edges and derive inverse blocker views. Do not persist redundant dependency arrays whose contents can diverge.

Parenthood alone imposes no sibling execution order. Readiness combines prerequisite satisfaction, work state, workflow policy, runner eligibility and resource capacity. A known failed prerequisite exposes a reason; it does not cause endless retries or prevent unrelated eligible children from progressing.

Acyclic explicit dependency edges are necessary but insufficient: a child must not wait for an ancestor's future result when that ancestor is waiting for the child's cohort. Reject unresolved ancestor prerequisites that cross the enclosing join; already accepted ancestor revision references remain valid context. Also reject a `merged` prerequisite within a cohort whose upstream merge is withheld until that same cohort completes. Use incremental cohorts, or an explicitly permitted upstream workflow that can integrate independently. These are checks of declared wait/phase obligations, not inference from task prose or a new planning solver.

### 5.3 The actual handoff and the mechanisms behind it

The preceding concepts do **not** require twelve new public contracts or messages passed between agents. The core addition is one delegation command plus a read operation. Child execution, output publication and parent continuation extend the existing workflow/activity, artifact, resource and execution mechanisms.

| Interaction                  | Explicit information                                                                                                                                                                                                                                                                                                                                          | Existing mechanism and necessary extension                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent requests child work   | Each child's objective and criteria (or exact brief references), allowed workflow, selected context references; repository/base for code; dependencies only where needed. Children are required by default and outputs use stable names from the first contract; optional membership is an unscheduled follow-on. Retry/version tokens accompany the request. | One `DelegateWork` application/MCP command, with an inspect/read operation. Wake generates child IDs, records the fixed batch membership, pins workflows and starts ordinary primary workflows.                                   |
| Child returns work           | Its ordinary activity outcome and named artifact/PR references; agent findings/summary where useful. A change output also identifies the inputs it used.                                                                                                                                                                                                      | Existing typed activity outcomes, artifact writes and verified PR registration. Extend result data with exact named outputs and consumed-input references. No separate result-submission tool or independent result lifecycle.    |
| Parent receives continuation | Results or a batch of blockers, with links/references to the relevant child output revisions.                                                                                                                                                                                                                                                                 | Existing activity dispatch and context provisioning, extended with a durable cohort wait, successful join and scoped attention reason. Wake schedules the activation; the parent agent reads the material and decides what to do. |

The parent selects the work and relevant evidence; it does not build a complete execution envelope. Wake supplies trusted parent/root, WorkItem/workflow/Run/activation IDs, actor/capabilities, pinned workflow definitions and the recorded version/provenance. Inspection/tool helpers return the opaque request/version handles needed for safe retries; agents must not invent identities or authorization. Ordinary criteria remain prose assessed by agents/review activities, not a new executable specification language.

Context is passed mainly **by reference**. The shared brief, plan, findings and reports remain in the existing artifact store. The child receives authorized revision references in its normal run context and reads them through existing artifact tools. A registered parent can discover accepted child output and receives exact result references on continuation. Siblings receive only selected shared/upstream references. There is no wholesale transcript transfer, duplicate content store or automatic shared `contextScope` enrollment.

The longer list previously in this section describes implementation details, not additional parent-child protocols:

| Detail                                    | How to keep it small                                                                                                                                                                                                                                                        | When needed                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Assignment and dependency references      | Use the child WorkItem plus output key and its assignment revision. One canonical edge direction; keep textual criteria with the assignment.                                                                                                                                | Basic delegation; dependency conditions grow only as their slices land.                             |
| Authority and registration/join records   | Extend existing scoped capabilities and durable orchestration facts. A delegation receipt contains batch membership/status; its resolved fact can also carry the exact qualifying results and continuation identity. Do not build separate receipt services.                | Basic delegation/recovery.                                                                          |
| Cross-WorkItem artifact access            | Reuse `ArtifactDelegationGrant`. Its `delegationId` is per immutable child/context grant, derived from cohort, child and grant revision. It is not the ID shared by the entire cohort.                                                                                      | Basic delegation; no new grant registry.                                                            |
| Repository selection and base             | Retain a selected existing Repository Resource in registration, with secondary correlations for context. Pass a recorded checkout ref/commit through Execution's workspace request, separately from intended PR base. Dynamic upstream-output resolution is optional later. | Code work; no repository-binding aggregate.                                                         |
| Exact output/evidence metadata            | Extend the typed activity output with artifact revision refs or verified PR/base/head facts, consumed inputs, assignment version and actual producer. Use existing Artifacts/Resources for ownership and bytes.                                                             | Artifact outputs first; change/review facts for code delivery.                                      |
| Combined candidate and prepared checkouts | One revisioned candidate document lists contributions, retained fetch sources, prepared commits and evidence. Execution supplies leased checkout paths through its existing activity context, extended to several repositories when necessary.                              | Parent combined QA; several paths only for multi-repository work.                                   |
| Action on a finished child's PR           | Extend a concrete configured parent integration/maintenance activity with a server-issued target: original output owner, PR/revision, permitted action and parent candidate decision. Keep requesting workflow/producer separate from resource ownership.                   | Post-result integration; existing-PR maintenance later. No arbitrary cross-WorkItem invocation API. |

These field groups may become small internal types during implementation. They do not all need to exist in the first release, and they do not need separate APIs or lifecycle objects. Later sections retain the authority, revision, recovery and ownership rules that their implementation must satisfy.

For the first release, assignment context references must already be accepted and readable by the parent; reject private/unaccepted references before committing the request. Newly written same-Run drafts cannot become child context implicitly. Later explicit handoff/recovery grants may support that case with retained draft status/provenance. The tool returns a durable registration receipt promptly; child execution and waiting are not long-running tool calls.

Assignment context is durable workflow input, not a second shared-memory system. Wake re-provisions the selected references for each eligible stage/attempt using existing artifact grants. Passing an artifact reference does not copy the parent's named `contextScope`, current-memory pointer or trusted operator instructions; child-local artifacts and accepted parent visibility continue through existing ownership/access rules.

A result submission identifies its own immutable assignment snapshot. Adding an unrelated batch must not reject an in-flight sibling result. The parent's current delivery selection must cover every original required assignment through its qualifying output or an authorized criteria-preserving replacement. An arbitrary artifact list cannot omit requirements. Record replacement facts immutably against the original assignment and expected currently selected output, with request deduplication/conflict checks; this is not general membership mutation. Earlier results and joins remain historical. In the later amendment extension, changes to a child's criteria, outputs or consumed inputs require reassessment; a global plan version alone must not invalidate unrelated work.

The workflow's selected activities judge whether textual criteria are met. A typed verdict ties that judgment to its subject revisions; Wake checks the actor, configured route, required verdict/evidence and freshness. Wake does not implement an acceptance-criteria language, infer correctness from a file existing, or judge agent prose. A test activity can record actual command outcomes, while an agent assesses whether the tests and implementation address the assignment.

Use `(parentWorkflowInstanceId, delegatingStage, requestId)` as the delegation idempotency scope, independent of a particular Run/activation. Replaying the same payload returns the original receipt even after plan advancement; reusing the key with different content is a typed conflict. New mutations compare the current plan revision. Credential validity and read authorization still apply to retries. Preserve the original trusted provenance, and record later recovery attempts separately.

Publish one durable intent before cross-stream registration. Reconcile graph membership, child creation, repository binding, explicit artifact grants and pinned workflow starts. Record one registration-ready boundary before any child can dispatch. Pending child activations are ineligible until that boundary; do not rely on append order or an in-memory guard. A committed request fences ordinary parent success immediately, including when the agent calls the tool and then exits incorrectly or crashes before returning a yield outcome. Reconciliation establishes the child wait without requiring a surviving CLI session.

Existing workflow/group claims serialize immutable batch registration. A Work-owned root revision or equivalent optimistic claim serializes ancestry, canonical dependency additions/cycle checks and descendant-count reservations across nested requests. Replays return the original registration/result; do not introduce a second mutable global planning model. Arbitrary membership/criteria editing remains deferred. Orchestration supplies pinned policy bounds and owns workflow/correction-budget use; Control Plane owns running-capacity accounting. Work does not interpret workflows, runner quotas or QA rounds. Orchestration owns the registration and wait process and references that plan; it does not keep another editable dependency graph. New child IDs derive from the request/local key so concurrent roots cannot adopt the same child. Existing primary workflow claims and activity/run claims remain the execution deduplication mechanisms. No multi-stream transaction is assumed.

## 6. Repository targets, branch inheritance and optional stacks

A coordinating parent can reference multiple authorized repositories. The first delivery model gives each implementation child one explicit target repository. A non-code investigation may inspect several authorized repositories; it must still produce explicit output context. Repository identity must not require inventing a GitHub issue for every internal child.

Two base-selection forms are required:

1. **Explicit base:** repository plus branch/ref, optionally an exact revision. If a branch/ref alone is submitted, Wake resolves and records its commit before dispatch.
2. **Upstream deliverable:** reference a named change output from another child. Wake waits for the required condition and resolves that output into a base branch and exact head revision.

Code inheritance is same-repository. A cross-repository dependency supplies a contract/artifact or prerequisite condition; it cannot serve as a Git base in another repository. A wrong repository, inaccessible ref, missing declared output or unauthorized target produces a specific rejection/block reason.

Initial branch creation must use the recorded base commit. Record the checkout source/ref separately from the intended logical PR base and retargeting behavior. They can differ: a replacement starts from an exact prior change while its PR targets the intended integration branch, not the superseded PR branch. An intentional stack layer may instead target its declared upstream branch. Record the base resolution with the attempt and deliverable so restarts reproduce it. Explicit repository selection must flow through execution, clone lookup, PR verification and run-report attribution; the old first-resource fallback cannot remain authoritative for registered child work. A retry must not silently reset an existing branch workspace or discard uncommitted changes. Ambiguous execution/side effects follow existing recovery policy before another writer is dispatched.

A child can publish a standalone PR, a stack layer, multiple explicitly named change outputs, or no PR. The first stack slice can constrain each stacking child to one designated change output while retaining a general deliverable manifest. Existing default PR targeting already rejects ambiguous primary PRs; preserve it. Resolve each named output to an explicit PR Resource ID for review/integration. A parent does not become the primary owner of a child PR to act on it. A concrete parent-workflow integration activity receives a server-issued `PostResultActionTarget` naming the original child owner and exact PR/revision. The activity queries authority and records delivery against that target owner/resource while its Run/outcome remains on the requesting parent workflow. This is an explicit extension to current PR activities, which query authority using the invocation WorkItem; passing only a different Resource ID is insufficient. That decision is a readiness prerequisite, not a new grant of merge authority; the activity must still satisfy the child's configured authority and explicit operator consent policy. Do not broadcast approval to other outputs or siblings.

Agents perform ordinary Git/PR operations using a stack-aware prompt or configured agent activity. They create commits, push branches, open PRs and perform rebases/retargeting; Wake prepares the authorized workspaces and records/validates their reported results. Do not add deterministic PR-creation jobs to make multi-PR delivery work. Wake verifies and records actual repository, base/head branches, commit revisions, PR/resource links and logical stack membership. Stack maintenance remains separate from WorkItem completion. Native stack features are optional adapter capabilities; ordinary Git branch/PR relationships provide the initial semantic slice.

### 6.1 Upstream changes and effective invalidation

Downstream evidence records which upstream outputs it consumed. Change identity includes the repository, base/ref revision and head, not only the head SHA: retargeting a PR changes its review/QA subject even if its head is unchanged. A changed upstream revision makes affected downstream results and parent QA stale until they are reconciled and reverified. Previous accepted facts remain historical; effective eligibility changes. Wake detects declared revision mismatches and schedules the configured assessment; agents decide whether to rebase, retest, replace a result or request a plan amendment. An unchanged unrelated output is not automatically made stale. A physically completed child is not automatically rewritten into a different lifecycle state; it receives explicit corrective/refresh work or a supported new activation.

Wake must not silently rebase an actively leased workspace. A maintenance/correction activity updates branch relationships under the appropriate lease, publishes its resulting revisions and causes dependent checks to be reevaluated. In-flight QA against an older candidate can finish and retain its result, but cannot authorize a newer candidate.

## 7. Review, parent QA and final integration

A child contract can end at delivery-ready with its PR still open. Workflow completion and deliverable readiness are exposed separately from provider merge state. Internal child completion must not automatically close the parent's external issue or trigger a global merge action.

Review can be a Wake-owned agent judgment rather than a provider-native PR review. It must identify the exact change/artifact scope, reviewer provenance, verdict and outstanding findings. Independent reviewer requirements remain configuration policy. Artifact publication or an agent's completion claim does not alone prove acceptance. Existing provider review/merge checks remain authoritative where a workflow requires them; an internal verdict does not impersonate an external approval.

The parent agent records a small current delivery selection: required child outputs and any explicit repair replacements, exact repository/source revisions, and assessment/check references. Use an existing artifact or typed activity input, not a candidate service. Old assignments and joins remain historical; every original required assignment must stay covered, replacements preserve its acceptance requirements and require the configured parent judgment. Replacement facts compare the expected current output so competing requests cannot silently overwrite one another. When QA or integration needs a combined candidate, this selection is its manifest. Wake validates join membership, declared dependency conditions, review/check freshness and repository/change relationships before preparing the QA assignment. A candidate can consist of two stack heads, one per repository, plus plan and evidence revisions. It can also contain independently assembled repository heads without any stack. It need not be merged into each repository's main branch before testing.

When configured QA needs several independent changes combined in one repository, an ordinary agent activity assembles their pinned heads in a leased workspace. An intentional linear stack normally already has a combined tip. Distinct assembly and QA stages are not universally required; use independent QA only where the chosen workflow requires it. If assembly produces a new commit consumed by another Run or recovery, the agent pushes a candidate-specific temporary ref to an authorized repository; Wake verifies the recorded commit is fetchable there before scheduling a separate QA checkout. Record that ref/source, the candidate revision and every contributing change revision. Retain candidate refs and consumed source revisions through QA, integration and any unresolved recovery; the first release retains those refs and performs no automatic deletion. A later cleanup activity must prove that it cannot delete active/pending evidence. Restart after deleting the assembly workspace must still reconstruct the candidate. A durable Git bundle is an alternative only if a future deployment cannot publish temporary refs; a reported local SHA alone is insufficient. The agent resolves ordinary conflicts within its assignment or reports a finding/proposes corrective work. Wake does not synthesize a repair plan from a conflict. Do not assume the last child's branch contains earlier independent changes. Assembly uses its own lease and cannot rewrite child branches; QA then checks out the recorded combined revision. Wake checks authorized source identities, exact revisions and declared manifest membership. Agents and configured review/QA judge whether cherry-picks, rebases and conflict resolutions preserve the intended contributions; Wake does not require every source head to be a Git ancestor or interpret patch semantics.

Wake prepares isolated checkouts at those exact revisions. The QA activity receives them, a configured test/environment recipe and overall acceptance criteria. Agents choose and perform additional useful investigation/testing within that assignment; explicit required checks still apply. Wake need not know how to combine a particular product or synthesize its environment. The QA activity returns evidence for that candidate. If the environment or revision is unavailable, QA reports that operational blocker rather than asserting success. Automatic generation of arbitrary deployment environments is outside scope.

Use the existing durable delivery intent/result facts for planned integration, extended with the parent/output context: candidate decision, exact attempted PR/revision, verified provider result and resulting repository commit. Do not create a separate integration-progress receipt lifecycle. Recheck the next action against actual refs. An expected merge does not by itself mean a defect, reopen a child or consume a correction round; an unrelated base move must not be mistaken for approved progress. If squash/rebase/retarget changes a remaining review/QA subject, preserve old evidence as history and request agent assessment plus the newly required review/checks for the actual revisions. Do not silently relabel old QA as evidence for a new candidate or blanket-invalidate unrelated outputs. The initial default refreshes affected verification. An optional future equivalence assessment would itself need both old and new revisions and an authorized verdict; it is not an alternative completion path to build in the first release. Partial integration is recoverable progress, not an atomic rollback promise.

Early shared-interface checks are permitted and encouraged; all QA required by the selected workflow remains mandatory. Do not add a universal separate combined-QA stage to workflows whose declared boundary is reviewed PR handoff. Cross-repository integration is not an atomic Git operation. Workflows must describe compatible integration order or deployment prerequisites; this feature does not promise atomic multi-repository merges or rollback.

On QA findings, the parent agent assesses the report and chooses a permitted correction/investigation path: resume the delegating implementation stage or request corrective children referring to the affected prior deliverables. Configured routes may handle routine outcomes directly, but a new deterministic supervisor is not required to classify defects, choose decomposition or decide the repair. The initial default creates a corrective child when the original child/workflow is already terminal; it does not assume completed primary claims can be silently reopened. An existing non-terminal child can receive a supported correction activation. Relevant candidate evidence becomes stale. Ordinary parent-directed repair uses another immutable child request, explicit replacement references and the existing workflow repeat/retry bounds plus root descendant limits; new children or provider switches do not reset those existing bounds. A specialized root correction-round subsystem is held until a concrete failure shows these limits insufficient. Exhaustion produces an inspectable escalation with unresolved findings, not an unbounded loop.

A terminal child primary is not restarted to merge its output. The scoped parent integration activity above supplies that post-result path, preserving the original primary claim, child PR ownership and target-specific consent/review/check policy. It must reject targets outside the validated delivery or affected by ancestor/target freeze, cancellation or deletion; completion of the producing workflow alone is not a denial or a new authorization. Record requesting Run/actor separately from resource owner. Initial implementation supports only the concrete configured approve/merge actions, not arbitrary cross-WorkItem activity invocation.

For an already terminal child's code defect, the default corrective child publishes a replacement PR owned by that new child, with an audited mapping to the original acceptance requirement. If the original contribution is still unmerged, the replacement must carry that contribution plus the fix and target the intended integration branch; a fix-only PR targeting the superseded branch is not a replacement. Explicit pinned checkout and agent replay/cherry-pick are sufficient: record the starting source commit separately from the logical PR base; a correction need not use a symbolic upstream base. It does not silently take ownership of or report the old PR as its own. The parent records the original output as superseded for delivery; closing a superseded PR is separate agent work under explicit authority. A nonterminal child can follow its supported correction activation. Later stack maintenance can explicitly target an existing terminal child's PR through a permitted parent agent activity: lease the target child's recorded branch workspace, retain its PR primary owner, record the actual maintenance producer and require fresh output/review evidence. Ambiguous prior writers must be reconciled first. Item 7 delivers concrete maintenance/review for the selected stack integration policy. Item 4 records dependency freshness; item 5 returns affected work to agent assessment. Repository preparation alone does not grant post-result branch access.

Parent completion occurs only after current required deliverables, QA and configured approval/integration gates are satisfied. Workflows that stop at QA-approved need not merge; workflows requiring merge do not complete merely because QA passed. Freeze/dispatch pause, operator consent and merge restrictions apply throughout.

## 8. MCP, configuration and execution

### 8.1 Agent-facing commands

Provide typed operations to submit a child cohort and inspect delegated work/results. Submit named deliverable references through the existing typed activity/agent outcome path; a separate mandatory result-submission MCP API is unnecessary. Corrections and plan amendments use narrowly authorized domain commands. Exact tool names and schemas are implementation decisions; use the established MCP naming and provisioning conventions.

A delegation submission includes stable request identity, local child keys for within-batch references, objectives/criteria, selected workflow, repository binding, required/optional designation, prerequisites, base request and artifact context references. Wake supplies trusted parent, actor, Run, activation and authority context from the issued capability. Tool arguments cannot manufacture that authority.

Expose no arbitrary `transitionTo`, raw event append or provider session-spawning operation. A request for execution characteristics must resolve through configured policies and runner pools. A child may use a different provider/model from siblings and parent. Quota fallback or session replacement preserves child/cohort identity and reassembles durable context; it must not duplicate work or transfer one provider's opaque session ID to another.

### 8.2 Configured behavior

One workflow-level policy declares allowed child workflows, root limits and any narrowing of repository authority. Agents in supported activities of that workflow may choose to delegate without repeated stage-level allowlists. Named output requirements and existing workflow routes/activities govern result qualification and final gates. Avoid a parallel policy language or a separate child-profile registry: a child profile is an allowed named workflow with an assignment/output contract. Proposed keys are shown below for implementation review; they are not valid current config.

Agent MCP delegation calls the owning application command first. A later static configured activity can reuse that command for predictable child work without an LLM choosing the process. An agent activity in a delegation-enabled workflow can choose direct execution or permitted delegation within its assignment authority. A configured child profile can end at delivery-ready rather than merge, independently of the parent profile.

Wake dispatches children when their declared prerequisites qualify. Parents may submit an upfront dependency graph or add later batches after assessing results; neither pattern requires a separate workflow type. A parent can request one child at a time when serial work is useful. Do not emulate parent-local serial execution by globally reducing all of Wake to one concurrent Run. Independent repositories may progress concurrently within limits.

### 8.3 Delegation is not a normal success outcome

A recorded delegation produces a receipt consumed through an owning-module contract. The stage enters a durable child wait/yield state with its configured continuation; it must not route through ordinary implementation success while required children are incomplete. Missing, malformed or unauthorized receipts cannot manufacture a wait or approval.

After resolution, Wake emits/consumes one durable continuation for that immutable batch. The parent agent inspects results and can create the next batch or take its ordinary configured route toward assessment/integration. Later mutable batch contracts would need their own explicit revision-qualified resolution identity. Inspection tools return immediately with current state; waiting belongs to orchestration rather than a long-running MCP call keeping a CLI alive.

### 8.4 Child attention while a cohort is unresolved

Expose blocked/failed required children, reasons and existing operator recovery from items 1 and 3. Independent children may continue; failures never count as success. An unsuccessful batch resolves through the ordinary continuation only after every member has settled, or outstanding members have been explicitly cancelled and their writers reconciled under existing policy. Independent members continue while the batch remains unresolved; a still-blocked member stays visible for operator recovery. This prevents a parent repair writer racing unfinished original work; the live attention below remains a distinct non-success continuation. The resolved result is explicitly unsuccessful, never a successful join. The parent may assess that settled result or escalate under its existing routes. A still-blocked child remains inspectable and does not trigger an unbounded parent polling loop.

Item 5 adds the live, parent-mediated clarification protocol below to coalesce blockers and resume children automatically. It completes the intended autonomous process; its response authority and races must be proved before enablement.

A required child requesting assignment clarification, becoming terminally failed/cancelled, or exhausting its configured budget raises durable parent attention. The delegating activity must support the typed attention input/outcome; a static non-agent delegation activity without such a handler emits one inspectable operator escalation instead of blindly replaying its child submission. Coalesce currently unresolved reasons into one parent activation at the delegating stage; key consumption by cohort contract revision and source blocker identities. The cohort remains unsatisfied. This activation is for agent assessment, not a successful join or permission to finish the parent.

The parent agent receives one batch of outstanding blockers and can provide assignment context, choose an already-authorized retry/replacement preserving criteria, or escalate necessary human questions together. A typed response targets the child workflow, blocker identity and expected assignment revision. After accepting that response as a parent activity outcome, Wake grants the exact published response references and resumes only a child blocked for that assignment context. It cannot answer a human-only decision/approval gate, reset exhausted budgets or approve siblings. Missing authority becomes an inspectable escalation rather than silent progress.

Use the existing parent activity/outcome and routing mechanism. An attention outcome restores the unresolved cohort wait unless an authorized amendment resolves/replaces it; it must not take the ordinary success route. Serialize attention and successful-join continuations on the parent workflow so at most one parent activation is active. A join satisfied during attention remains durably pending until that activation finishes; newly arriving blockers are coalesced for the next assessment. Freeze/cancellation applies to both lanes. Item 5 delivers this live protocol; items 1 and 3 already provide durable failure visibility and ordinary unsuccessful-batch handling.

### 8.5 Proposed minimal configuration

Use one optional `delegation` policy on the existing named workflow definition. Its presence enables supported agent activities to request delegation; omission disables requests from that workflow. A workflow does not need this policy merely to run as a child. The child workflow list bounds selection without requiring the author to predict every delegating stage. This is a **future schema sketch**, not valid current configuration:

```yaml
delegation:
  workflows: [investigation-child, implementation-child]
  maxDepth: 1
  maxDescendants: 8
  maxConcurrentRuns: 2
```

`workflows` is a nonempty allowlist. Runner/model choice stays in the selected workflow's existing stage execution/runner-pool configuration. Existing activity authority and review independence still apply: selecting a child workflow cannot grant permissions absent from the invoking assignment. Descendants may narrow policy but cannot broaden root authority or limits. Code assignments select from the parent delivery's authorized repository set; optional workflow-level `repositories` may narrow it further. Omitting that field never grants all configured repositories. Artifacts-only assignments need no repository. Bootstrap resolves identities through configured integrations/public ports; runtime registration rejects missing or unauthorized targets.

The normal continuation resumes the delegating stage for parent assessment, then uses that stage's ordinary configured outcome routes. Do not require repeated `afterJoin: resume` fields or an agent-selected transition target. Per-stage delegation restrictions and special direct-to-stage join routes can be added later for a demonstrated need; they are not required initial configuration. A later static configured activity may reuse the application command. The compiler checks that the invoking activity can handle batch results and, when enabled, attention outcomes; a child itself need not know which parent is waiting.

Wake records the child workflow's successful completion and exact required output/review facts. That qualifies the child's result, not the entire delivery. Once every required child in the committed cohort qualifies, the durable join resumes the parent once. A blocked/failed child exposes its reason and the appropriate unsuccessful-batch/operator path; item 5 automates live attention; a child reaching a failed terminal route does not count as successful. An open child PR is compatible with delivery-ready completion. The child never emits a hand-written parent approval/join signal.

Use named outputs and normal typed activity results from the first contract. Item 8 implements several independently verified PR outputs per child without changing that contract. A workflow may declare `outputs`, a map from unique output key to `{kind: artifact | change, required: true | false}`; required defaults true. The assignment names the selected outputs and textual criteria, and may strengthen but not drop configured requirements. Existing routes determine which successful terminal path qualifies these outputs, including required review. A recorded failed/blocked/rejected activity outcome must never qualify merely because it appears in `acceptedOutcomes`. Keep detailed review/QA content in revisioned artifacts rather than adding config expressions for its prose.

Root limits above are recommended opt-in defaults, not changes to today's global defaults. Depth one is the default operating policy, not a hard-coded implementation limit. Item 1 establishes bounded nested identity/waits; item 3 enforces configured depth and root reservations for every descendant. Eight descendants allow the six-child example plus two corrective children; raise deliberately when necessary. `maxConcurrentRuns: 2` caps all running activities in the tree, including parent/watch/review work, below global and runner limits; a waiting parent consumes no Run slot. Use existing bounded workflow repeat/retry routes and the total child limit for ordinary repair. Do not add `maxCorrectionRounds` or a second correction-round definition as a prerequisite. Provider retries and workflow review budgets retain their existing meanings.

Start with submit-cohort and inspect capabilities plus typed named outputs on the existing activity outcome. Add plan amendments/correction requests as their slices require; do not expose arbitrary objective revision, reparenting, consent changes, closure or raw graph edits. Optional serial execution can later lower a root/subgroup cap without changing global concurrency. No stack-specific config is needed initially: an explicit upstream output/base and observed PR relationships describe a stack.

### 8.6 Capacity, trigger and reporting compatibility

Extend `maxOpenWorkItems` to use the validated root delivery identity for registered delegated work: a parent waiting for children and its descendants consume one open-delivery slot, not one per started child. Preserve current standalone/trigger invocation accounting, frozen/deleted exclusions and the unlimited default. A new root still needs headroom; a registered descendant of an admitted root does not need another open-work slot. Recheck global Run capacity, the root Run cap, ancestor freeze/cancellation and dependencies at dispatch. Prove a parent plus two children can finish with `maxOpenWorkItems: 1` and `maxConcurrentRuns: 1`.

Keep the root counted while any required delivery workflow remains nonterminal; explicitly resolve unfinished optional work before final completion. Freeze/cancel affects the subtree, and excluded frozen trees must not dispatch descendants. An internal child never enters GitHub intake or needs assignment on a fabricated issue. Current dispatch priority applies among eligible activities; root portfolio preference and fairness are separate follow-on policies.

When a trigger invocation delegates, descendants retain its trusted origin for self-source suppression; otherwise child completion can spuriously retrigger the same scope. Do not enroll descendants in its named `contextScope` or create recurring sibling parentage. Keep the invocation's single-flight claim until its parent workflow resolves the delegated work and terminates under the final gate. Run now and trigger pause retain their existing meanings; neither bypasses root/ancestor execution controls.

Expose counts for root deliveries, accepted child results and correction work separately. Preserve per-Run usage/duration/runner metrics. A result refresh does not count as another delivered root. Do not reinterpret historical primary completions or descriptive parent links during replay.

## 9. Artifacts, context and authority

Reference exact artifact revisions/digests for the shared brief, acceptance criteria, plans, assumptions, child findings and QA reports. Parent/child WorkItems remain distinct owners; do not copy context bytes into a second canonical conversation or graph store.

Reuse the implemented Artifact-owned [context contracts](../../src/artifacts/contracts/context.ts) and trusted directional delegation grants, whose intended behavior is described in the [oversight spec](delivery-oversight.md#6-artifact-context-scopes-and-focus). `registerChild` is the registration seam. Its `ArtifactDelegationGrant.delegationId` identifies one immutable grant, not a cohort: derive a per-child grant ID from cohort, child and grant revision. Additional prerequisite or refreshed-reference grants get new IDs; replay reuses identical payloads. Do not mutate an existing grant or create a second grant registry; `childReferences` and `parentReferences` supply references for run provisioning. Combine those with local access in the existing MCP provisioner. No new sharing engine is needed. Shared references are additive: each WorkItem retains its own local artifacts and producer-owned writes even when it receives a named context. Child assignments reference selected parent context; parents may read accepted artifacts from their registered children; QA receives candidate evidence. Siblings receive only required shared/upstream context. Named-context membership does not automatically export all local output. Delegation does not enroll a child in the parent trigger's named context or transfer its current memory/operator instructions. If operator instructions must be supplied later, preserve their distinct trusted provenance and explicit snapshot; an agent artifact cannot confer it. Writes remain producer-owned, including when a parent reads child output. Exact revisions and original ownership disambiguate local/shared paths and identify assignment/review evidence; scope membership never makes every artifact writable. Review independence rules can restrict implementation transcripts while still granting required specification/change evidence.

Artifact publication and evidence acceptance remain separate. Read grants may expose inspectable accepted-outcome artifacts even when a review rejected the work. Joins consume only exact manifest revisions qualified by the configured successful outcome/review. Parent discovery of newer child artifacts does not silently replace an earlier accepted result. Unaccepted drafts from interrupted attempts need an explicit recovery/handoff grant if required, carrying draft status and original provenance. Changing a shared brief/criterion revision triggers relevant plan/evidence reevaluation rather than silently changing every child's contract.

Delegation credentials are scoped to parent/child ancestry, authorized repository/workflow choices, mutation classes, and current Run/activation. Existing expiry/revocation behavior applies. An identity in `CommandContext` is audit provenance, not sufficient authorization by itself. Operator consent, required human review and final merge authority are never broadened by delegation. Enforce mutation permissions in the Wake application/MCP command itself; a prompt or runner `allowedTools` list is not its authorization check. Current Codex tool restrictions can be advisory, so do not claim that these command capabilities independently sandbox arbitrary external CLI effects.

## 10. Persistence, concurrency and recovery

Use module-owned typed events, optimistic concurrency and stable command/request identities. All new facts must be decoded before folding; projections remain rebuildable. Existing watch provenance and same-WorkItem child semantics remain intact and must not be reinterpreted as independent child work.

Creation spans several aggregates. Record a durable delegation intent/claim and reconcile child WorkItem creation, repository binding, context grants and workflow start idempotently. Do not assume a transaction across journal streams. A child becomes dispatchable only after its required registration facts are complete. Expose incomplete registrations and recover them; replay must neither drop nor duplicate children.

Use existing optimistic claims for immutable batch registration and a delivery-root Work-owned revision or equivalent claim to serialize ancestry, dependency additions/cycle checks and descendant reservations. Keep one canonical dependency representation; no general reparenting or arbitrary graph-editing API is required. A stale mutation receives a typed conflict and can be reconsidered against current state. Depth and budget claims must remain correct when multiple authorized requests race.

Parent wait registration and child result consumption must handle either event ordering. A child that finishes before the parent fully registers its wait still contributes its recorded result. A join claim/receipt prevents duplicate parent continuation. Retained delivery candidates and artifact references must remain inspectable after restart and workspace cleanup.

Cancellation stops dispatch of newly ineligible required descendants and cancels active work under existing execution policy. Freeze prevents new work/mutations in the frozen subtree; already running work may finish according to existing freeze semantics, but cannot cause a frozen parent to advance. A child cancellation/failure remains an unsatisfied result and exposes its reason while unrelated branches continue where policy permits. Unsuccessful-batch handling and operator recovery remain available; live attention cannot convert a failed required result into join success.

## 11. Module ownership and recommended implementation seams

| Module          | New or extended responsibility                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work`          | Validated hierarchy/root, criteria and canonical prerequisite edges, root plan revision and descendant reservations; no workflow or provider semantics                                                                            |
| `resources`     | Explicit repository bindings, external change identity/correlations and verified provider observations                                                                                                                            |
| `orchestration` | Workflow-level delegation permissions/pinning, registration/cohort claims, child wait/join/continuation and gate-qualified result/candidate eligibility                                                                           |
| `activities`    | Typed deliverable/candidate/evidence contracts; agent implementation/PR creation, stack maintenance, assembly, review/QA and correction activities; existing PR authority                                                         |
| `execution`     | Prepare authorized base/candidate checkouts, including multiple repository leases with deterministic acquisition order and partial-acquisition cleanup; retain attempt provenance, cancellation and provider-independent recovery |
| `control-plane` | Eligibility and dispatch respecting dependencies, freeze, quotas and per-delivery capacity                                                                                                                                        |
| `artifacts`     | Related-work revision read grants, retained provenance and explicit recovery access                                                                                                                                               |
| `integrations`  | Verify/observe agent-created PRs, base/head/resource facts and existing outbound delivery reconciliation; no new PR-authoring engine                                                                                              |
| `surfaces`      | Work tree, dependency/blocker views, delegation tools and operator controls via public applications                                                                                                                               |
| `bootstrap`     | Compose domain applications/ports, processors, scoped capabilities and concrete adapters                                                                                                                                          |

Keep repository/provider payloads out of `work`. Work records prerequisite intent using Work/output identities; Orchestration evaluates it using typed deliverable/provider facts supplied through public ports. Work never polls Git or judges a review. Put typed manifest/evidence schemas in Activities and reference Artifacts through an explicit acyclic public dependency (`activities -> artifacts -> work`) if needed; do not hide document validation in Bootstrap or add an undefined delivery-judgment module. Artifacts does not import Orchestration. Bootstrap wires accepted-outcome and delegation callbacks; it owns no graph or acceptance policy. Compose cross-module registration through typed ports and Bootstrap; extend declared dependencies only where acyclic ownership requires them. Delegated children start independent primary workflows/groups. Their delegation receipt and Work hierarchy provide parentage; do not populate the existing watch-only `parentWorkflowInstanceId`/watch provenance fields, which require the same WorkItem/group and drive watch completion logic. Extend primary startup to honor the workflow fingerprint committed at registration: today `StartWorkflow` selects the current named definition. Reconciliation must resolve the recorded definition or expose it as unavailable, never silently repin after config changes.

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

| ID    | Observable acceptance                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DC-01 | Existing single-flow work completes through its configured gates without creating children                                                                                                                                     |
| DC-02 | Upfront request creates two independent children, queues prerequisites and returns stable IDs                                                                                                                                  |
| DC-03 | Replayed request after lost tool response returns the same children; no extra workflow or consent facts appear                                                                                                                 |
| DC-04 | Incremental delegation resumes the parent after an investigation and creates later implementation children using its exact accepted findings                                                                                   |
| DC-05 | Children use different allowed workflows/providers; disallowed workflows/repos/mutations are rejected before dispatch                                                                                                          |
| DC-06 | Child WorkItem identity differs from the parent; existing watch-child review gates retain their previous behavior                                                                                                              |
| DC-07 | Self-dependency, hierarchy/dependency cycles, missing targets and stale plan revisions produce typed rejections/conflicts                                                                                                      |
| DC-08 | Depth/descendant/correction limits survive restart and concurrent requests; grandchildren cannot bypass them                                                                                                                   |
| DC-09 | A valid child result arriving before wait registration is consumed once; duplicate events do not resume the parent twice                                                                                                       |
| DC-10 | A required child failure/cancellation blocks the relevant join, optional exclusion is explicit, and an independent branch can continue                                                                                         |
| DC-11 | Explicit branch base resolves to a recorded commit; unavailable or wrong-repository bases expose an actionable reason                                                                                                          |
| DC-12 | Child B starts from child A's verified pushed change before merge when configured; merged prerequisites wait for actual merge evidence                                                                                         |
| DC-13 | Six implementation tasks across two repositories can form two declared stacks, with a cross-repository contract dependency and independent progress                                                                            |
| DC-14 | A non-code child and standalone PR child complete without stack membership                                                                                                                                                     |
| DC-15 | Child finishes with required review/check evidence while its PR remains open; parent external issue remains open                                                                                                               |
| DC-16 | QA receives exact repository revisions and shared criteria, including assembled independent changes when required; testing main or a different candidate cannot satisfy the gate                                               |
| DC-17 | Upstream change makes affected downstream review/QA stale; unrelated evidence remains effective                                                                                                                                |
| DC-18 | QA findings create/resume permitted corrective work and repeat verification within budgets                                                                                                                                     |
| DC-19 | A frozen/cancelled parent does not advance or dispatch new descendants through a late completion event                                                                                                                         |
| DC-20 | Parent/child context grants permit required artifact reads, deny unrelated work/draft reads and preserve producer-only writes                                                                                                  |
| DC-21 | Quota fallback, unavailable session and Wake restart preserve child/cohort/base/result identity; ambiguity is reconciled before redispatch                                                                                     |
| DC-22 | Interrupted partial registration recovers without making an incomplete child executable                                                                                                                                        |
| DC-23 | Operator sees tree, workflow, repository, base, prerequisites, join status, stale evidence and reason for any block                                                                                                            |
| DC-24 | QA-approved-only parent can finish without merge; merge-required parent remains incomplete until integration gates are met                                                                                                     |
| DC-25 | Completion metrics distinguish accepted child deliverables from final parent delivery and show corrective activations without duplicate delivery counts                                                                        |
| DC-26 | With one open-work slot and one Run slot, a waiting parent and its registered children complete without WIP deadlock; an unrelated root waits                                                                                  |
| DC-27 | A delegated trigger child's events do not retrigger its originating scope, confer shared-context membership or release the invocation claim early                                                                              |
| DC-28 | A tool commits delegation and the agent returns ordinary success or crashes; registration/wait recovery fences advancement and starts no partial child                                                                         |
| DC-29 | One child publishes two named PR outputs; review/merge addresses explicit resources, rejects ambiguous defaults and preserves each PR's child ownership                                                                        |
| DC-30 | An agent creates PRs and maintains a stack in leased workspaces; Wake prepares/checks the bases and verifies actual results without authoring the PRs or choosing a repair                                                     |
| DC-31 | One cohort registers two distinct child artifact grants, replays both, and can add a later prerequisite grant without mutating or conflicting with either earlier grant                                                        |
| DC-32 | A required child needs assignment context or exhausts retries; one batched parent-attention activation responds/escalates without satisfying the join, resetting budgets or bypassing human review                             |
| DC-33 | A terminal child's PR merges through a scoped parent activity without primary-claim reopening or correlation transfer; a corrective replacement PR retains its new owner                                                       |
| DC-34 | QA reconstructs the exact candidate after assembly workspace deletion/restart from a verified retained source; missing/moved candidate refs cannot pass preparation                                                            |
| DC-35 | Reject implicit ancestor-join and merge-before-same-join cycles even when the explicit dependency edges are acyclic; accepted ancestor context remains usable                                                                  |
| DC-36 | Planned first-PR merge, unrelated base movement and squash/retarget produce explicit progress/freshness decisions; only affected subjects need new evidence and ordinary integration does not consume defect-correction rounds |

Use pure domain/unit tests for decisions and composed fake integration tests for registration, dispatch, artifacts, delivery and recovery. Workspace/base and stack tests require real Git filesystem fixtures and fake providers. Focused process/filesystem E2E fixtures run serially. Surface changes need relevant API/web tests. No live model tokens are required to prove orchestration correctness; a later bounded agent trial evaluates decomposition and prompt behavior separately.

## 14. Agreed progressive delivery sequence

This sequence replaces D1-D9 and the narrower C1-C6/E1-E7 alternative considered in the [scope review](../reports/2026-10-18-delegated-child-work-scope-review.md). The operator chose the target as the aim: optimize the path rather than introduce temporary products or restrictions. These are nine flat implementation issues, with one shared `delegated-delivery` label and existing priority labels. Do not create sub-issues until Wake supports them. A separate low-priority follow-on tracker records uncertain ideas without scheduling their implementation.

Build immutable assignment, named-output, root identity and authority contracts once. A slice may initially exercise fewer outputs or a depth-one configuration, but must not introduce replacement APIs or single-output/depth-one-only domain models. Unsupported behavior remains explicit until its implementation lands. Each slice owns focused correctness, authority and recovery tests; the final integration slice includes the composed working-process proof rather than leaving hardening to a later story.

### I1. Durable delegation to ordinary child workflows

**Outcome/unlock:** a parent invokes compatible ordinary multi-stage workflows on independent WorkItems and durably resumes with their exact qualifying results. A child needs no parent-specific join stage.

**Scope:** validated owning parent/root; bounded nested identity and wait semantics; immutable assignment and cohort identity; named outputs; exact selected artifact inputs; pinned workflow startup; registration intent/reconciliation and dispatch fence; per-child immutable artifact grant IDs; duplicate-safe result qualification, join and continuation. Distinguish unsuccessful-batch assessment from a successful join; do not strand running siblings or bypass unresolved blockers. Preserve existing same-WorkItem watch children and direct execution.

**Acceptance:** lost responses, partial registration, restart and result-before-wait recover exactly once; accepted activation alone does not qualify success; nested parents join safely; implicit ancestor/join cycles are rejected. Cover DC-01, DC-03, DC-04, DC-06, DC-09, DC-20 through DC-22, DC-28, DC-31 and nested identity/waits in DC-08/DC-35.

**Dependencies/priority:** none; high. Artifact-only fixtures are internal proofs, not an intermediate release requirement.

### I2. Repository-bound assignments and reproducible branch bases

**Outcome/unlock:** each child carries its authorized repository, pinned starting source and logical PR base through planning, review, implementation and an agent-created reviewed PR. Different children may use different repositories immediately.

**Scope:** explicit Repository Resource selection without fabricated issues; resolve branch requests to commits; initialize new writable branches at that commit; preserve workspace/lease/dirty-state recovery; review the plan revision or evolving implementation head as appropriate; normal typed named-output reporting and provider verification. Source commit and logical PR base are distinct. Prepare for independently verified multiple outputs without implementing all of them here.

**Acceptance:** two real Git repositories, branch movement between stages, unavailable/wrong-repo source, exact review subject, PR open at qualifying child completion, original ownership retained. DC-11, DC-14, DC-15, DC-21 and repository/base portions of DC-12/DC-30.

**Dependencies/priority:** I1 contracts; high. Workspace/provider work can develop alongside I1 once those contracts are fixed.

### I3. Agent delegation tools and delivery-wide controls

**Outcome/unlock:** agents can submit/inspect children under one workflow-level policy; operators can inspect or stop them; a parent occupying the final open-work slot can still finish its descendants.

**Scope:** run-scoped MCP capabilities and ordinary outcomes; allowed named workflows and inherited assignment/repository authority; configurable depth/descendant/root Run bounds; one root per open-work slot; ancestor freeze/cancel; trigger-origin self-source suppression; IDs, workflow/status, repository/PR links and blocker visibility in existing surfaces. Enforce controls before enabling production delegation.

**Acceptance:** stale/wrong-parent/escalating capabilities denied; concurrent nested requests cannot exceed root reservations; one WIP slot and one Run slot completes a tree; waiting parents consume no Run slot; freeze/cancel and trigger suppression survive recovery. DC-05, DC-08, DC-19, DC-23 basic inspection, DC-26 and DC-27.

**Dependencies/priority:** I1; high. Develop alongside I2; root caps do not promise scheduling fairness.

### I4. Dependencies and stacked PRs across repositories

**Outcome/unlock:** agents can declare work upfront or incrementally, run independent work concurrently and intentionally build unmerged stacks within each repository.

**Scope:** explicit prerequisite conditions, selected named upstream outputs/context and pinned upstream bases; same-repo Git validation versus cross-repo context dependencies; exact consumed revisions; canonical and implicit wait-cycle checks; stale downstream ineligibility. Wake checks readiness and freshness; agents choose decomposition and Git operations. Do not invent stack membership from parenthood or PR ordering.

**Acceptance:** six tasks over two repositories, an intentional stack in each, cross-repo contract handoff, upstream pushed before merge, actual merge evidence for merge prerequisites, restart and upstream/base movement. Reject merge-before-same-join and ancestor-join deadlocks despite an acyclic explicit graph. DC-02, DC-07, DC-12, DC-13, DC-17, DC-30 and DC-35.

**Dependencies/priority:** I1-I3; high. No general adoption, reparenting or arbitrary graph-editing API.

### I5. Parent coordination when work needs attention

**Outcome/unlock:** the parent agent answers assignment questions, assesses failures and changed upstream work, requests permitted follow-up work and batches genuinely necessary human questions while unrelated children continue.

**Scope:** durable coalesced attention at the delegating stage; narrow expected-revision response/context grants; serialize attention and successful join without losing either; changed upstream inputs remain ineligible until agent reassessment and required evidence refresh. Preserve root/workflow budgets and human-only approval gates.

**Acceptance:** attention/result races, duplicate blockers/replies, late blockers, changed dependency while a child runs, no accidental successful join or hidden live-child lane, frozen/cancelled parent, unauthorized human-gate reply. DC-10, DC-17, DC-19 and DC-32.

**Dependencies/priority:** I1/I3; upstream-change integration uses I4; high. This is agent coordination through existing activities, not a new deterministic supervisor.

### I6. Parent QA and bounded agent-led correction

**Outcome/unlock:** parent agents assess the exact combined work, run configured QA and choose bounded repairs across repositories without losing original requirements.

**Scope:** exact current selection covering every required assignment or authorized criteria-preserving replacement; prepare required repository checkouts; ordinary agent assembly only when needed; verify retained fetchable candidate sources; record QA against exact inputs. Repairs use supported nonterminal correction or a new child with immutable replacement references and expected-current checks. A terminal replacement PR carries the original unmerged contribution plus the fix against its intended integration branch. New children/providers do not reset root or workflow bounds; downstream old consumers remain stale.

**Acceptance:** exact multi-repo candidate QA, reconstruction after workspace deletion, unavailable environment/source, lower-layer replacement with stale downstream result, repair convergence/exhaustion and denied requirement waiver. DC-16 through DC-18, DC-24 handoff boundary and DC-34.

**Dependencies/priority:** I2-I5; high. No mandatory assembly stage, automatic semantic proof or separate correction-round service.

### I7. Governed integration and stack maintenance

**Outcome/unlock:** the configured parent delivery integrates child-owned PRs after their workflows finish, including agent-led maintenance, refreshed verification and partial-progress recovery.

**Scope:** concrete target context with parent requester/Run, original child owner, PR Resource, exact revision, allowed action and parent decision; retain target consent/review/check policy and lease discipline. Agents retarget/rebase; record actual producer and new immutable output subject; refresh affected review/checks/QA before selection advances. Reuse delivery intents/results; no ownership transfer, reopened primary claim or separate progress lifecycle.

**Acceptance:** terminal child integration and denied authority escalation; successful first-layer merge -> required agent maintenance -> new target facts -> required fresh review/QA -> restart -> remaining merges. Prove partial integration, unrelated base movement, squash/retarget, frozen targets and ambiguous writers. The production composition must demonstrate the six-child/two-repository autonomous path with permanent fake agents/providers and real Git fixtures; safe stopping alone cannot prove delivery. DC-24 merge boundary, DC-30, DC-33 and DC-36 plus combined earlier recovery scenarios.

**Dependencies/priority:** I2-I4/I6; high. Contract work can develop alongside I6. No atomic multi-repository rollback promise.

### I8. Multiple PR outputs from one child

**Outcome/unlock:** a coherent assignment may publish several independently verified PR outputs without splitting into artificial WorkItems.

**Scope:** implement the I1 named-output map across branch/workspace provenance, provider verification, explicit review/merge targets and dependency/current-selection references. Preserve original owner and criteria per output; ambiguous default targets fail explicitly. Extend I7 integration coverage when several outputs participate in one delivery.

**Acceptance:** one child publishes two PRs with independent source/base/head/provenance and review targets; one stale/missing output cannot qualify another; explicit integration does not silently select the first PR. DC-29 plus multi-output forms of DC-17/DC-33.

**Dependencies/priority:** I1-I3; medium. Does not depend on general correction machinery; may proceed once those contracts are available.

### I9. Delivery inspection and reporting

**Outcome/unlock:** operators can understand the tree, dependencies, current output/evidence selection, PRs and blockers, and distinguish final delivery throughput from child/correction activity.

**Scope:** expand existing projections, APIs and UI, retaining per-Run reports and original provenance. Show why evidence is stale and what is waiting; do not build another workflow engine or portfolio dashboard. Basic inspection already ships with I3.

**Acceptance:** nested/multi-repo/multi-output delivery with attention, repair, partial integration and restart is accurately represented without duplicate root completion counts or historical reinterpretation. Relevant API/web tests; DC-23 and DC-25.

**Dependencies/priority:** I3-I8 for the complete projection; medium. Read-only surface work may start earlier against fixed contracts.

### Critical path and stopping point

```text
I1 final contracts -> I2 repository preparation + I3 tools/controls
I1/I2/I3           -> I4 dependencies/stacks
I1/I3 (+ I4)       -> I5 parent attention
I2..I5             -> I6 exact QA/repair -> I7 integration + complete proof
I1/I2/I3           -> I8 multiple PR outputs
I3..I8             -> I9 complete inspection/reporting
```

I1-I7 deliver the autonomous multi-repository stacked-PR process. I8 and I9 provide clear additional utility and complete the high-confidence planned investment. Readiness depends on verified prerequisite implementation being merged or available on the intended base, not issue closure or priority alone. Each issue includes its own focused recovery and authority tests plus relevant current reference/catalogue/scenario updates and `npm run verify:agent` before a code PR handoff.

Stop scheduling implementation after I9. One separate unassigned follow-on tracker records optional/speculative children and more elaborate scheduling; general reparenting/adoption/cross-delivery dependencies; unpublished cross-child draft transfer; static configured delegation; automatic retained-ref cleanup; and fairness/performance/evidence-reuse optimizations justified by operational data. These are uncertain follow-ons, not hidden prerequisites or an automatic continuation queue. Drop mandatory separate supervisor/receipt/integration-progress services and universal assembly/QA stages; chosen workflow gates remain mandatory.

### Filed issues and triage scope

Created in `atolis-hq/wake` on 2026-10-18. All are flat, open and unassigned; none has `dark-factory`. Implementation issues share `delegated-delivery`; the follow-on tracker shares that tag but is explicitly outside the dispatch set.

| Slice | Issue                                                                                                            | Priority | Required implementation prerequisites |
| ----- | ---------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| I1    | [#960: durable delegation to ordinary child workflows](https://github.com/atolis-hq/wake/issues/960)             | High     | None in this sequence                 |
| I2    | [#961: repository-bound assignments and reproducible branch bases](https://github.com/atolis-hq/wake/issues/961) | High     | #960                                  |
| I3    | [#962: agent delegation tools and delivery-wide controls](https://github.com/atolis-hq/wake/issues/962)          | High     | #960                                  |
| I4    | [#963: dependencies and stacked PRs across repositories](https://github.com/atolis-hq/wake/issues/963)           | High     | #960, #961, #962                      |
| I5    | [#964: parent coordination when work needs attention](https://github.com/atolis-hq/wake/issues/964)              | High     | #960, #962, #963                      |
| I6    | [#965: parent QA and bounded agent-led correction](https://github.com/atolis-hq/wake/issues/965)                 | High     | #961, #962, #963, #964                |
| I7    | [#966: governed integration and stack maintenance](https://github.com/atolis-hq/wake/issues/966)                 | High     | #961, #962, #963, #965                |
| I8    | [#967: multiple PR outputs from one child](https://github.com/atolis-hq/wake/issues/967)                         | Medium   | #960, #961, #962                      |
| I9    | [#968: delivery inspection and reporting](https://github.com/atolis-hq/wake/issues/968)                          | Medium   | #962, #963, #964, #965, #966, #967    |

Follow-on tracker: [#969](https://github.com/atolis-hq/wake/issues/969), `priority: low`; unassigned and non-dispatchable.

Use the triage trigger's existing named-scope **operator standing instructions**, rather than editing the generic triage prompt or creating a new trigger, to restrict future selection. Instructions apply to every trigger sharing that scope. Preserve any compatible existing standing instructions. The following block is ready to paste; it does not change current workflow dispatch configuration:

```text
Only select and assign implementation work in atolis-hq/wake from this exact allowlist:
#960, #961, #962, #963, #964, #965, #966, #967, #968.
Require the delegated-delivery label as well. Never select or assign #969
(follow-on tracker), or any other issue, even if it shares that label.

Within this set, prefer priority: high before priority: medium, then the lower
delivery sequence number among ready items. Verify every explicit prerequisite
using its implementation PRs and intended-base evidence; issue closure alone
does not prove readiness. Skip blocked or uncertain items.

Keep the existing capacity, active-work, one-selection-per-invocation and
assignment-recovery rules. Do not alter workflow/dispatch labels, create issues
or sub-issues, or dispatch the follow-on tracker. Reading other issues/PRs to
verify prerequisites and active work is permitted; selecting them is not.

If no allowlisted item is verified ready, or active work makes assignment
inappropriate, record a successful no-op. After the allowlist is complete,
continue to no-op; never fall back to the general backlog.
```

### Mapping from former sequences

| Former area    | Agreed placement                                                |
| -------------- | --------------------------------------------------------------- |
| D1, C1         | I1 identity/registration/nesting and I4 canonical prerequisites |
| D2, E1         | I1 ordinary child/join; I5 live attention                       |
| D3a/D3b, C3    | I3 interface/root controls; I9 expanded inspection              |
| D4a/D4b, C2    | I2 repository/base/agent PR behavior                            |
| D5, E3         | I8 multiple outputs, with named contracts in I1                 |
| D6a, C4        | I6 current selection/candidate QA; I7 scoped integration        |
| D6b            | I5/I6 agent-led bounded repair without a separate supervisor    |
| D7             | I2 different-repo children; I6 exact multi-repository checkouts |
| D8a/D8b, E2    | I4 declared dependencies; I5 reassessment; I7 agent maintenance |
| D9a/D9b, C6/E6 | I3 basic visibility; I7 working composition; I9 reporting       |

## 15. Remaining behavioral decisions and recommended defaults

The agreed behavior is retained: optional direct/delegated execution, upfront/incremental requests, configurable child workflows, separate work/dependency/stack relations, child completion before merge, exact evidence, parent QA and configured final integration. The recommendations below resolve operating choices for implementation review; they do not assert new user approval or change running configuration.

| Choice                                             | Recommended default                                                                                                                                                          | Reason / alternative retained                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Who decides decomposition, correctness and repair? | Agents decide within their assignment; configured reviewers/QA judge. Wake checks authority, declared prerequisites, provenance, exact revisions and configured gates.       | Preserves the existing agent/Wake balance. No deterministic semantic planner, acceptance-prose evaluator or new supervisor prerequisite. |
| Who creates PRs and maintains stacks?              | Agents commit/push/open PRs and perform rebase/retarget/conflict work. Wake prepares checkouts and verifies actual results.                                                  | Existing deterministic approval/merge activities remain available only through explicit configured authority; no new PR-creation engine. |
| Minimum release                                    | I1-I7 deliver autonomous parent/child work, dependencies, attention, exact QA and configured integration in two repositories.                                                | Artifact-only fixtures are internal proofs; an earlier reviewed-PR handoff must be labelled as such.                                     |
| Delegation configuration                           | One workflow-level allowlist and root limits; supported agent activities decide when to delegate within their assignment authority.                                          | No mandatory per-stage child-workflow lists. Running as a child does not itself require enabling recursive delegation.                   |
| Join continuation                                  | Resume the delegating stage for parent assessment, then follow its existing outcome routes.                                                                                  | No repeated per-stage resume config or child-authored parent signal. Special direct stage targets can wait for a concrete need.          |
| Child attention                                    | Visible blockers from I1/I3; batched live parent attention and narrowly authorized assignment replies in I5.                                                                 | Never fake a successful join or bypass human approval; serialize attention and join continuations.                                       |
| Required/optional children                         | Required by default; optional/speculative children remain in the unscheduled follow-on tracker.                                                                              | Optional-child benefit is uncertain; do not add optional disposition machinery before demand exists.                                     |
| Result acceptance                                  | The child's configured successful completion/review route plus required exact outputs qualifies its result; parent agent still assesses combined adequacy.                   | Publication/accepted activation alone is insufficient. Parent may request correction without rewriting historical success.               |
| Scope changes                                      | Append immutable batches/dependencies within authority and budget; technical replacements preserve criteria and expected-current selection. No arbitrary requirement waiver. | Old results stay historical; no requirement waiver or hidden global mutable plan.                                                        |
| Recursion and size                                 | Default depth one, eight descendants, two concurrent delivery Runs; support explicitly configured bounded nesting with root-wide reservations.                               | Keeps safe operating defaults without a temporary depth-one-only domain model.                                                           |
| Corrections                                        | Parent chooses ordinary further repair assignments and replacement references, bounded by current workflow retry/repeat and root child limits.                               | No reopened primary claim, automatic correction supervisor or extra correction-round subsystem.                                          |
| Dependencies                                       | Support upfront and incremental dependencies in I4; qualify explicit prerequisite conditions and pin consumed upstream revisions before dispatch.                            | Agents choose decomposition; Wake checks declared readiness and explicit/implicit wait cycles.                                           |
| Stacks                                             | Opt in through named upstream base/output; no mandatory stack per repository. Use named outputs from I1, with several independently verified PR outputs enabled in I8.       | Ordinary standalone changes and multi-output repository work remain first-class.                                                         |
| Final integration                                  | Inherit the chosen parent workflow's existing QA/approval/merge boundary. Child implementation workflow normally stops delivery-ready with PR open.                          | No global merge default, broad parent approval inheritance or automatic parent issue closure from a child result.                        |
| Capacity/reporting                                 | One validated root per open-work slot; every running tree activity consumes real Run capacity. Separate child versus final-delivery throughput.                              | Prevent parent/child deadlock; preserve current standalone/trigger behavior and global defaults.                                         |
| Context                                            | Local artifacts plus explicit directional accepted-revision grants; selected upstream context only; no automatic named scope or operator-instruction inheritance.            | Reuses implemented sharing, preserves reviewer boundaries and producer writes. Draft recovery is an explicit grant.                      |

No additional human product decision is required to prepare this sequence. Revisit with the operator if a concrete deployment needs a different final approval/merge policy, trusted instruction inheritance, a higher recursive scope or a materially different first release. Ordinary type names, event layout, configuration parsing, port wiring and fixture recipes are implementation choices, not reasons to interrupt the user.

Success measures include correct overall completion, avoidable human interruptions, time blocked by prerequisites, review/QA correction convergence, duplicate dispatch/registration count, restart recovery and provider allowance use. Fewer sessions/questions or more occupied slots do not establish success if incorrect work passes.

Deferred: arbitrary agent-authored workflow code, a generic supervisor/assignment/session/stack service, cross-delivery dependencies, adoption/reparenting of existing work, a general findings/questions/ACL language, automatic environment synthesis, atomic multi-repository merge/rollback and mandatory runtime/plugin replacement. None is needed for the contracts above.

Before rollout, verify historical decoding/replay, legacy watch gates, single-flow execution, artifact permissions and existing PR authority. Never migrate descriptive relations into executable dependencies or reinterpret same-WorkItem child facts implicitly.

### Review verification

This is a documentation/design change, not a runtime implementation. Focused existing tests were run against the reviewed code: 23 unit tests covering artifact context/MCP, open-work policy, PR authority and completion metrics; 97 integration tests covering composed triggers, artifact context/operator snapshots and Git workspaces. All passed. Existing test fixtures emitted unrouted-outcome warnings. These tests verify reusable foundations, not the proposed DC behaviors. Formatting/link/diff checks are reported with the document handoff; the full code PR gate, browser and E2E suites are not claimed.

The [independent review](../reports/2026-10-18-delegated-child-work-review.md) records the subsequent contract findings, fixes, simplifications and bounded re-review. DC-31 through DC-36 cover those corrections; they remain proposed acceptance scenarios. No runtime test result is claimed for the new behavior.

The [fresh scope review](../reports/2026-10-18-delegated-child-work-scope-review.md) records the C1-C6 simplification alternative. The operator subsequently chose the direct target path in section 14, retaining parent attention, declared prerequisites, bounded nesting, multiple outputs and useful reporting while dropping extra intermediate architecture. The report remains the record of that review rather than current delivery sequencing.

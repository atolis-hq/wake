# Work Graphs in Wake

## Purpose

This document introduces the concept of a **work graph** and explains how it may apply to Wake.

It assumes the reader already understands Wake’s current architecture and operating model:

- Work is typically initiated through an issue or ticket.
- Wake observes external channels such as GitHub Issues.
- Each item progresses through explicit lifecycle stages.
- Wake emits and persists events into issue or work streams.
- Projections rebuild current state from the event log.
- Agent execution is delegated to local coding-agent CLIs.
- External surfaces such as issues and pull requests are used for discussion, approval, and reporting.

The aim here is not to prescribe a graph database or force a redesign of the existing event-sourced model. The aim is to describe a potentially useful **conceptual and read-model extension**:

> A unit of engineering work is not identical to any one issue, pull request, Slack thread, document, or agent session. It is a durable entity that may be represented, discussed, executed, reviewed, and completed across many different systems.

The work graph is a model of those entities and relationships.

---

## Relationship to ADR 0001

[ADR 0001](../adrs/0001-correlating-external-resources-to-work-items.md) defines the first layer of this model: the work-to-surface layer (section 9.2 below). Its correlation registry records each surface as a typed edge from the work item — a `wake.correlation.registered` event whose resource URI (`<provider>:<kind>:<locator>`) identifies the resource node and whose `role` (`representation | implementation | discussion | review | documentation | decision | ...`) is the edge type. Per resource, exactly one work item holds `relation: primary` and owns lifecycle resumption and reply routing.

This document describes the rest of the model: the work identity those edges hang off (§15), work-to-work topology (§9.1), and software impact (§9.3). The [implementation plan](../plans/2026-07-12-work-graph-implementation-plan.md) sequences which parts land now and which are deferred.

---

## 1. Why this concept matters

Wake currently centres work around an issue or ticket. That is a sensible starting point because an issue provides:

- A durable external identifier.
- A human-readable description.
- A place for discussion.
- A familiar assignment mechanism.
- A source of lifecycle signals.
- A place to report plans, questions, progress, and results.

For the current GitHub-first workflow, the issue functions as both:

1. The place where work is represented to the user.
2. The identity around which Wake correlates execution and state.

Those roles overlap naturally while GitHub Issues is the primary entry point.

However, as Wake expands into pull-request conversations, Slack, Jira, ADRs, engineering requirement documents, design reviews, and other channels, an important distinction begins to emerge:

> The issue may be the initial container or representation of the work, but it is not necessarily the work itself.

A single piece of work may eventually involve all of the following:

- A Jira backlog item.
- A GitHub issue created for implementation.
- A Slack thread used to clarify requirements.
- An architecture decision record.
- A design or engineering requirements document.
- One or more agent execution sessions.
- A branch and pull request.
- Inline review comments.
- A follow-up issue discovered during implementation.
- A deployment record.
- A production incident linked back to the original change.

No individual one of those objects fully represents the work. They are different manifestations, artifacts, discussions, or consequences of it.

A work graph gives Wake a model for understanding those relationships explicitly.

---

## 2. The current issue-centric model

A simplified view of the current model might look like this:

```text
GitHub Issue
     |
     v
Wake work stream
     |
     +-- lifecycle state
     +-- comments and approvals
     +-- agent executions
     +-- workspace
     +-- result
     +-- pull request
```

This works well because Wake can treat the issue as the durable anchor.

The stream might contain events such as:

```text
IssueDiscovered
RefinementStarted
AgentSessionStarted
PlanProposed
PlanApproved
ImplementationStarted
PullRequestCreated
ReviewCommentReceived
ImplementationResumed
WorkCompleted
```

A current-state projection can rebuild a view such as:

```text
Work: github:atolis-hq/quorum#42
Stage: awaiting-review
Runner: claude-code
Session: claude-abc
Pull request: #87
```

Nothing about the work-graph concept invalidates this design.

The work graph becomes useful when Wake needs to answer questions that are no longer confined to one stream or one external object.

Examples include:

- Which work items are blocked by this one?
- Which ADR justified this implementation?
- Which Slack discussion changed the accepted plan?
- Which agent execution created the pull request?
- Which issues affect a particular software module?
- Which production incident was caused by this change?
- Which follow-up work was discovered during implementation?
- Which discussions and decisions belong to the same underlying work?

An issue-centric projection is excellent at describing the current state of one item. A graph is better at describing relationships across items, artifacts, systems, and time.

---

## 3. The subtle conceptual shift

The shift is not necessarily from “issue” to “something completely different.” It is from:

> The issue is the work.

to:

> The issue is one representation of the work.

Wake makes this distinction concrete in its identity model: a work item is identified by a provider-independent work ID, and every external surface — including the originating ticket — is a linked representation:

```text
Work: work-01JXYZ
    |
    +-- represented by GitHub Issue #42
    +-- represented by Jira PAY-314
    +-- discussed in Slack thread T123
    +-- implemented by Pull Request #87
```

No platform object is the identity or the permanent container of the work — which matters because platform objects have different lifecycles from the work itself.

For example:

- A Jira story may be moved to another project.
- A GitHub issue may be closed when a pull request opens.
- A Slack thread may continue after the issue is marked complete.
- A design document may exist before any implementation issue is created.
- One issue may be split into several implementation items.
- Several issues may contribute to one architectural decision.
- A production incident may reopen or supersede previously completed work.

The durable conceptual entity is the work. The surfaces are how humans and systems interact with it.

---

## 4. What a work graph is

A work graph is a connected model of:

- Units of work.
- External representations.
- Conversations.
- Documents.
- Decisions.
- Executions.
- Source-control artifacts.
- Human and agent actors.
- Dependencies and lineage.
- Affected software entities.

At its simplest, the graph consists of nodes and typed edges.

### Example nodes

```text
Work
GitHubIssue
JiraTicket
SlackThread
PullRequest
Commit
Branch
ADR
EngineeringRequirementsDocument
ReviewComment
Decision
Approval
AgentExecution
Human
AgentIdentity
Repository
SoftwareModule
Service
Incident
Deployment
```

### Example relationships

```text
Work --REPRESENTED_BY--> GitHubIssue
Work --REPRESENTED_BY--> JiraTicket
Work --DISCUSSED_IN--> SlackThread
Work --IMPLEMENTED_BY--> PullRequest
Work --DECIDED_BY--> ADR
Work --DOCUMENTED_IN--> EngineeringRequirementsDocument
Work --EXECUTED_THROUGH--> AgentExecution
AgentExecution --CREATED--> PullRequest
PullRequest --CONTAINS--> Commit
Work --DEPENDS_ON--> Work
Work --DISCOVERED_DURING--> Work
Work --SUPERSEDES--> Work
Work --AFFECTS--> SoftwareModule
Incident --CAUSED_BY--> PullRequest
ReviewComment --REQUESTS_CHANGE_TO--> PullRequest
Decision --APPROVED_BY--> Human
```

The graph is not intended to duplicate every field from every external system. It records the identities and relationships Wake needs in order to coordinate, explain, and resume work.

---

## 5. A representative scenario

Consider a piece of work that begins as a Jira backlog item:

```text
PAY-314: Support employees changing tax residency mid-period
```

During refinement, Wake may:

1. Start a Slack thread to clarify product behaviour.
2. Create an engineering requirements document.
3. Create an ADR because the change affects calculation boundaries.
4. Create a GitHub implementation issue.
5. Run a Claude Code session to investigate the codebase.
6. Propose a plan in the GitHub issue.
7. Receive approval.
8. Run a second execution session to implement the change.
9. Open a pull request.
10. Receive inline review comments.
11. Resume the same underlying work through another agent session.
12. Merge the pull request.
13. Create a follow-up issue for migration tooling.
14. Later associate a production incident with the change.

A surface-centric view produces several disconnected records:

```text
Jira PAY-314
Slack thread
Requirements document
ADR-17
GitHub Issue #42
Claude session A
Claude session B
Pull Request #87
Review comments
Follow-up Issue #58
Incident INC-102
```

A work-centric graph connects them:

```text
                         +--> Slack Thread
                         |
                         +--> Requirements Document
                         |
                         +--> ADR-17
                         |
[Work: PAY-314] ---------+--> GitHub Issue #42
                         |
                         +--> Agent Execution A
                         |
                         +--> Agent Execution B
                         |
                         +--> Pull Request #87
                         |
                         +--> Follow-up Work
                         |
                         +--> Incident INC-102
```

More precisely, the graph would preserve the meanings of those connections:

```text
Work --REPRESENTED_BY--> Jira PAY-314
Work --DISCUSSED_IN--> Slack Thread
Work --DOCUMENTED_IN--> Requirements Document
Work --DECIDED_BY--> ADR-17
Work --REPRESENTED_BY--> GitHub Issue #42
Work --EXECUTED_THROUGH--> Agent Execution A
Work --EXECUTED_THROUGH--> Agent Execution B
Work --IMPLEMENTED_BY--> Pull Request #87
Follow-up Work --DISCOVERED_DURING--> Work
Incident INC-102 --RELATED_TO--> Work
Incident INC-102 --CAUSED_BY--> Pull Request #87
```

That graph gives Wake a durable account of the work across systems.

---

## 6. Event sourcing is a strong foundation

Wake’s event-sourced architecture lends itself naturally to a work graph.

The recommended conceptual relationship is:

> The event log remains the authoritative history.  
> The work graph is a rebuildable projection of that history.

This is analogous to other Wake projections.

The event stream answers:

> What happened to this work item, and in what order?

The graph answers:

> What is this work connected to?

These are complementary questions.

### Example event stream

```text
stream: work-123

WorkCreated
CorrelationRegistered   (github issue, role: representation)
RefinementStarted
CorrelationRegistered   (slack thread, role: discussion)
AgentExecutionStarted
PlanProposed
PlanApproved
CorrelationRegistered   (pull request, role: implementation)
ReviewCommentObserved
AgentExecutionResumed
WorkCompleted
```

### Current-state projection

```text
Work 123
Stage: complete
Primary issue: GitHub #42
Pull request: #87
Latest execution: claude-session-b
```

### Graph projection

```text
[Work 123] --REPRESENTED_BY--> [GitHub Issue #42]
[Work 123] --DISCUSSED_IN--> [Slack Thread]
[Work 123] --EXECUTED_THROUGH--> [Claude Session A]
[Work 123] --EXECUTED_THROUGH--> [Claude Session B]
[Work 123] --IMPLEMENTED_BY--> [Pull Request #87]
[Claude Session B] --CREATED--> [Pull Request #87]
```

The same events can feed both projections.

---

## 7. Events as graph mutations

A graph projector can interpret selected domain events as changes to nodes and relationships.

Surface links all arrive as the generic registration event from ADR 0001:

```typescript
type CorrelationRegistered = {
  sourceEventType: "wake.correlation.registered";
  workItemKey: string;
  payload: {
    resourceUri: string;              // e.g. "github:issue:atolis-hq/quorum#42"
    role: string;                     // e.g. "representation"
    relation: "primary" | "secondary";
    registeredBy?: string;            // e.g. the run that produced the artifact
  };
};
```

This projects to:

```text
UPSERT Work(workItemKey)
UPSERT Resource(resourceUri)
UPSERT Work -[REPRESENTED_BY]-> Resource     // edge type derived from role
```

An execution event:

```typescript
type AgentExecutionStarted = {
  type: "AgentExecutionStarted";
  workId: string;
  executionId: string;
  runner: string;
  sessionId?: string;
};
```

may project to:

```text
UPSERT AgentExecution(executionId)
UPSERT Work -[EXECUTED_THROUGH]-> AgentExecution
```

A pull request registration (`role: implementation`, `registeredBy: <run id>`) projects to several relationships at once:

```text
UPSERT PullRequest(resourceUri)
UPSERT Work -[IMPLEMENTED_BY]-> PullRequest
UPSERT AgentExecution -[CREATED]-> PullRequest
```

One event may therefore update several graph relationships.

This logic should live in a projector rather than being scattered as imperative graph writes throughout Wake.

Prefer:

```typescript
emit(new PullRequestCreated(...));
```

followed by graph projection.

Avoid:

```typescript
await createPullRequest();
await graph.addNode(...);
await graph.addEdge(...);
```

The projector approach preserves:

- Rebuildability.
- Idempotency.
- Crash recovery.
- Schema evolution.
- Separation between domain behaviour and read-model concerns.
- The option to replace the graph storage technology later.

---

## 8. Streams remain valid aggregate boundaries

A graph does not imply that Wake should stop using per-work or per-issue streams.

Streams and graphs solve different modelling problems.

A stream provides:

- Ordered history.
- Aggregate consistency.
- State reconstruction.
- Clear ownership of emitted events.
- A natural unit for commands and lifecycle transitions.

A graph provides:

- Cross-stream relationships.
- Multi-hop traversal.
- Dependency and lineage views.
- Connections to external artifacts.
- Connections to software structure.
- Broader organisational context.

For example, two work streams may remain separate:

```text
stream: work-123
stream: work-98
```

An event in `work-123` can record:

```typescript
type WorkDependencyAdded = {
  type: "WorkDependencyAdded";
  workId: "work-123";
  dependsOnWorkId: "work-98";
};
```

The graph projection produces:

```text
[Work 123] --DEPENDS_ON--> [Work 98]
```

The edge crosses stream boundaries without changing the ownership or ordering semantics of either stream.

This is one of the strongest reasons to treat the graph as a projection rather than the transactional write model.

---

## 9. Three useful graph layers

The overall graph can be understood as three related layers.

## 9.1 Work topology

This describes relationships between units of work.

Examples:

```text
Work A --DEPENDS_ON--> Work B
Work A --BLOCKED_BY--> Work C
Work A --SPLIT_INTO--> Work D
Work E --DISCOVERED_DURING--> Work A
Work F --SUPERSEDES--> Work G
Work H --FOLLOW_UP_TO--> Work A
Work I --DUPLICATES--> Work J
```

This is useful for:

- Planning.
- Prioritisation.
- Dependency management.
- Detecting blocked work.
- Understanding how scope expanded.
- Following the lineage of an architectural change.
- Deciding which item should execute next.

It is related to issue links in Jira or GitHub, but it is owned by Wake rather than constrained to one provider’s relationship model.

## 9.2 Work evidence and surfaces

This connects work to the places where it is represented or discussed.

Examples:

```text
Work A --REPRESENTED_BY--> GitHub Issue #42
Work A --REPRESENTED_BY--> Jira PAY-314
Work A --DISCUSSED_IN--> Slack Thread
Work A --IMPLEMENTED_BY--> Pull Request #87
Work A --DECIDED_BY--> ADR-17
Work A --DOCUMENTED_IN--> Engineering Requirements Document
Work A --REVIEWED_IN--> Pull Request Review
```

This layer supports Wake’s “colleague across surfaces” goal.

A human colleague is not identical to Slack, GitHub, Jira, or a document. Those are the places where the colleague participates. Wake should similarly retain an identity and understanding of work that survives movement between surfaces.

## 9.3 Software impact

This connects work to the software system it changes.

Examples:

```text
Work A --AFFECTS--> Payroll Module
Work A --CHANGES--> Residency Calculation Service
Work A --INTRODUCES--> TaxResidencyChanged Event
Work A --REMOVES--> Legacy Residency Resolver
Work A --MODIFIES_RELATIONSHIP--> Payroll Service calls Tax Service
```

This is where Wake can potentially connect with Quorum’s software graph.

Quorum may describe:

```text
Repository --CONTAINS--> Module
Module --CONTAINS--> Class
Service --CALLS--> Service
Component --PUBLISHES--> Event
```

Wake adds the change history and rationale:

```text
Work --CHANGES--> Module
ADR --GOVERNS--> Service Relationship
Pull Request --MODIFIES--> Component
Incident --EXPOSES_PROBLEM_IN--> Module
```

Together, the software graph answers **what exists**, while the work graph answers **why and how it changed**.

---

## 10. The graph should not simply mirror the event log

It is possible to model every event as a graph node:

```text
Work --HAD_EVENT--> PlanApprovedEvent
PlanApprovedEvent --FOLLOWED--> ImplementationStartedEvent
```

This creates an event graph, but it may not be the most useful default.

Wake already has an event log that preserves:

- Exact ordering.
- Detailed payloads.
- Historical reconstruction.
- Auditability.

Duplicating every event as a node risks producing a large and noisy graph.

A better default is to create graph nodes for entities with durable identity and edges for meaningful relationships.

Likely node candidates include:

- Work items.
- External issues and tickets.
- Pull requests.
- Commits.
- Branches.
- Documents.
- ADRs.
- Slack threads.
- Agent executions.
- Human and agent identities.
- Decisions.
- Incidents.
- Deployments.
- Repositories and software entities.

Some events may justify durable nodes of their own when other things need to refer to them.

Examples include:

- A formal architecture decision.
- A human approval.
- A rejected plan.
- A handoff.
- A production incident.
- A significant review conclusion.

The selection criterion is not “did this happen?” It is:

> Does this thing have durable identity or need to participate in relationships?

---

## 11. Conversations belong to work, not sessions or surfaces

A major implication of the work-graph model is that conversation continuity should attach to the work.

Without this model, Wake may drift toward treating each integration as a separate session:

```text
GitHub issue conversation
Slack conversation
Pull request review conversation
Document conversation
```

From the user’s perspective, however, these may all be one continuous discussion.

For example:

1. Requirements are clarified in Slack.
2. Wake proposes a plan in GitHub.
3. A reviewer challenges a design choice in the pull request.
4. Wake updates an ADR.
5. The team continues the discussion in the document.

A human colleague carries context between those interactions. Wake should do the same.

The graph can represent this explicitly:

```text
Work
  +-- DISCUSSED_IN --> Slack Thread
  +-- DISCUSSED_IN --> GitHub Issue
  +-- REVIEWED_IN --> Pull Request
  +-- DOCUMENTED_IN --> ADR
```

Agent sessions then become execution attempts associated with the work, rather than the primary container of memory:

```text
Work --EXECUTED_THROUGH--> Claude Session A
Work --EXECUTED_THROUGH--> Codex Session B
Claude Session A --HANDED_OFF_TO--> Codex Session B
```

This makes runner switching, resumption, and budget-aware routing conceptually cleaner. The work persists even when the execution session changes.

---

## 12. Temporal relationships

Many graph relationships are not timeless.

A work item may:

- Be assigned to one agent and later another.
- Be represented by a GitHub issue and later migrated to Jira.
- Affect one proposed software design before the plan is revised.
- Be blocked for a period and then unblocked.
- Use one execution session before a handoff.
- Have one accepted ADR later superseded by another.

Edges can therefore include temporal or status metadata:

```typescript
type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: {
    createdAt?: string;
    endedAt?: string;
    status?: string;
    sequence?: number;
    sourceEventId?: string;
    reason?: string;
  };
};
```

For example:

```text
Work --EXECUTED_THROUGH--> Claude Session A
  startedAt: ...
  endedAt: ...
  status: exhausted-budget

Work --EXECUTED_THROUGH--> Codex Session B
  startedAt: ...
  status: completed
```

Or:

```text
Claude Session A --HANDED_OFF_TO--> Codex Session B
  reason: provider-budget-exhausted
```

This supports questions such as:

- Which runner first investigated the work?
- Which execution produced the accepted plan?
- Which session created the merged code?
- How often was the work handed off?
- What was the accepted decision at a particular point in time?
- Which dependency was blocking the work when an execution failed?

The event log remains the definitive temporal record, but temporal graph metadata makes relationship queries practical.

---

## 13. Questions a work graph enables

A work graph becomes valuable when Wake needs to answer or act on cross-cutting questions.

### Coordination questions

- Which work is currently blocked by this item?
- Which open items depend on a decision that has not been approved?
- Which follow-up items were discovered during implementation?
- Which work should be resumed after a dependency closes?
- Which work items are connected to the same architectural change?

### Context questions

- What discussions influenced this plan?
- Which ADR explains this implementation?
- Where was this requirement clarified?
- Which previous work modified the same subsystem?
- What context should be supplied to the next agent execution?

### Execution questions

- Which sessions have attempted this work?
- Which runner produced the current branch?
- Which execution failed before a successful handoff?
- Which model or runner performs best for this class of work?
- Which execution consumed tokens without producing an accepted artifact?

### Software-impact questions

- Which active work affects the payroll calculation module?
- Which recent pull requests changed this service boundary?
- What work introduced this event contract?
- Which incidents relate to changes in this component?
- Which unmerged work overlaps the same software entities?

### Explanation and organisational-memory questions

- Why was this system designed this way?
- What chain of decisions led to this implementation?
- Which work item introduced this dependency?
- What discussions and review comments led to the final code?
- What happened after this change reached production?

These are graph-shaped questions because the answer requires traversing relationships rather than reading one stream in isolation.

---

## 14. Work graph versus state machine

Wake’s lifecycle state machine remains important.

A lifecycle projection might answer:

```text
Work A is awaiting plan approval.
Work B is implementing.
Work C is awaiting review.
```

A graph adds context around that state:

```text
Work A is awaiting plan approval
  and is blocked by Work D,
  affects Module X,
  is represented in Jira and GitHub,
  and has an unresolved question in Slack.
```

The state machine describes the control state of one work item.

The graph describes its broader position in the engineering system.

They should not be conflated.

A work graph also makes it possible to avoid forcing every concern into one linear status.

A work item may simultaneously have:

- Architecture approved.
- Implementation in progress.
- Documentation pending.
- Review blocked.
- Deployment unscheduled.

These may be modelled as aspects, relationships, or subordinate work rather than one increasingly complex enum.

The graph does not automatically solve that modelling problem, but it gives Wake more options than a single linear state.

---

## 15. Identity and correlation

A graph depends on stable identities.

Wake should distinguish between:

### Internal work identity

```text
work-01JXYZ
```

### External surface identity

Using ADR 0001's resource-URI grammar (`<provider>:<kind>:<locator>`):

```text
github:issue:atolis-hq/quorum#42
jira:issue:PAY-314
slack:thread:C0123/1699999999.000042
github:pr:atolis-hq/quorum#87
```

### Execution identity

```text
execution-01JABC
claude-session-id
codex-thread-id
```

### Software entity identity

```text
quorum:repository:atolis-hq/quorum
quorum:module:payroll-calculation
quorum:service:tax-residency
```

Wake may not need all of these immediately. The important guidance is to avoid accidental identity coupling: a Claude session ID must never become the work ID, and no external surface ID is the work's identity.

The adopted model (see the [implementation plan](../plans/2026-07-12-work-graph-implementation-plan.md)):

```text
stream ID = internal work ID (e.g. work-01JXYZ)
the originating ticket is the primary representation
GitHub issue, Jira item, Slack thread, and documents are linked surfaces
```

---

## 16. Storage options

The work-graph concept does not require adopting Neo4j or another graph database.

A minimal projection can use two logical collections.

```typescript
type GraphNode = {
  id: string;
  type: string;
  properties: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
};
```

A relational implementation may use:

```text
graph_nodes
-----------
id
type
properties_json
created_at
updated_at

graph_edges
-----------
id
from_node_id
to_node_id
type
properties_json
created_at
updated_at
```

Useful indexes include:

```text
graph_nodes(type)
graph_edges(from_node_id)
graph_edges(to_node_id)
graph_edges(type)
graph_edges(from_node_id, type)
graph_edges(to_node_id, type)
```

This is sufficient for many first-order and limited multi-hop queries.

A graph database becomes more attractive when Wake needs:

- Frequent arbitrary multi-hop traversal.
- Path finding.
- Graph algorithms.
- Large-scale dependency analysis.
- Rich graph visualisation.
- Complex pattern matching across many entity types.

The storage decision should follow actual query needs rather than the conceptual model.

Because the graph is projected from events, it can be rebuilt into a different storage engine later.

---

## 17. Projection design guidance

A graph projection should be:

### Rebuildable

It should be possible to discard and rebuild the graph from the event log.

### Idempotent

Reprocessing an event should not create duplicate nodes or edges.

Stable node and edge identifiers help:

```text
node ID:
github-issue:atolis-hq/quorum:42

edge ID:
work-123:REPRESENTED_BY:github-issue:atolis-hq/quorum:42
```

### Versioned

Graph semantics will evolve. Projector versions or rebuild migrations may be needed as relationship names and node types mature.

### Source-aware

Nodes and edges should retain provenance where useful:

```text
sourceEventId
sourceStreamId
sourceProvider
observedAt
```

This helps explain why a relationship exists and supports correction when external data changes.

### Selective

Not every event or external object needs a node. The graph should preserve meaningful identities and relationships rather than becoming a raw mirror of all available data.

### Eventually consistent

The graph is a read model. It may lag briefly behind the event stream without becoming the source of truth for commands.

---

## 18. Domain events that may become useful

Wake may already have many of these concepts under different names. The following examples illustrate graph-relevant semantics rather than required event names.

### Surfaces, conversations, and documents

Every work-to-surface relationship — tickets, pull requests, Slack threads, documents, ADRs — is recorded by the single generic registration event pair from ADR 0001:

```text
wake.correlation.registered   (resourceUri + role + relation)
wake.correlation.retracted
```

A new surface never adds a core event type; it adds a URI `kind` and, at most, a new `role` value. Distinct event types are reserved for relationships whose semantics genuinely differ, as in the categories below.

### Work identity

```text
WorkCreated
PrimaryRepresentationChanged
```

### Work relationships

```text
DependencyAdded
DependencyRemoved
WorkBlocked
WorkUnblocked
WorkSplit
FollowUpWorkCreated
WorkSuperseded
DuplicateIdentified
```

### Decisions and approvals

```text
DecisionRecorded
ApprovalRecorded
```

### Execution

```text
AgentExecutionStarted
AgentExecutionResumed
AgentExecutionCompleted
AgentExecutionFailed
AgentExecutionHandedOff
RunnerChanged
```

### Source control

Pull requests and branches enter the graph as registrations (`role: implementation`); the events below record activity *on* them:

```text
BranchCreated
CommitObserved
ReviewCommentObserved
PullRequestMerged
```

### Software impact

```text
SoftwareEntityAffected
SoftwareEntityIntroduced
SoftwareEntityRemoved
ArchitectureRelationshipChanged
```

### Operational consequences

```text
DeploymentLinked
IncidentLinked
RegressionIdentified
RemediationWorkCreated
```

These events should be introduced because they represent useful domain facts, not merely to populate a graph.

---

## 19. Integrating with Quorum’s software graph

The strongest long-term opportunity may be connecting Wake’s work graph to Quorum’s software graph.

A software graph may contain:

```text
Repository
Module
Namespace
Class
Function
API
Service
Database
Event
Dependency
Ownership boundary
```

Wake contributes:

```text
Work
Issue
Decision
ADR
Conversation
Execution
Pull Request
Review
Incident
Deployment
```

The connecting relationships may include:

```text
Work --AFFECTS--> Module
PullRequest --MODIFIES--> Class
ADR --GOVERNS--> Service
Incident --IMPACTS--> API
Work --INTRODUCES--> Event
ReviewComment --QUESTIONS--> Architecture Relationship
```

This creates a combined model of:

1. **What the system is.**
2. **What work changed it.**
3. **Why the change was made.**
4. **Who or what executed it.**
5. **What happened afterward.**

For an agent, this can improve context selection.

Instead of passing an entire repository or a manually assembled prompt, Wake could traverse:

```text
Current Work
  -> affected software entities
  -> related previous work
  -> governing ADRs
  -> unresolved review discussions
  -> recent incidents
```

The resulting context is relationship-aware rather than merely text-search based.

This should be treated as a longer-term opportunity, not a prerequisite for the initial work-graph projection.

---

## 20. Potential risks

### Competing with established work-graph products

Asana's work graph, Atlassian's Teamwork Graph, and similar products already own the work-graph-as-product space. Wake's graph exists to coordinate its own autonomous work — correlation, context assembly, reply routing, and sequencing — not to provide portfolio views, reporting, or an organisational planning tool.

Where an organisation already runs such a tool, Wake should plug in through its adapter seams (the tool is a `WorkSource`; externally maintained relationships enter as correlation or topology events) rather than replicate it. Model only what coordination needs.

### Over-modelling too early

It is easy to invent a large ontology before Wake has real queries that require it.

Prefer modelling relationships that support current or near-term workflows.

### Treating the graph as the transactional source of truth

This may weaken the current event-sourced consistency model and make rebuildability harder.

Prefer the event log as the authoritative record and the graph as a projection.

### Mirroring external systems indiscriminately

Wake does not need to ingest every GitHub, Jira, or Slack object.

Model the identities and relationships relevant to Wake’s coordination role.

### Creating an event graph instead of a work graph

Representing every event as a node may produce complexity without improving reasoning.

Prefer durable domain entities and meaningful edges.

### Coupling the graph to one provider

Relationship types should be Wake concepts where possible:

```text
REPRESENTED_BY
DISCUSSED_IN
IMPLEMENTED_BY
```

rather than provider-specific concepts such as:

```text
HAS_GITHUB_ISSUE
HAS_SLACK_THREAD
```

Provider-specific identity can remain on the target node.

### Assuming one work item maps to one issue

Real work may be:

- Represented by several tickets.
- Split into child work.
- Implemented by several pull requests.
- Discussed across several channels.
- Governed by several decisions.

The graph should allow cardinality to emerge from real workflows.

---

## 21. An incremental path

A sensible sequence would be:

### Stage 1: Establish work identity

Identify work by an internal, provider-independent work ID; key streams and projections by it; register the originating ticket as the primary representation. This is deliberately first — it is the only change that becomes a migration if delayed (see the [implementation plan](../plans/2026-07-12-work-graph-implementation-plan.md)).

### Stage 2: Add explicit relationship events

Introduce only the relationships Wake already needs. Surface links (pull requests, conversations, documents) flow through the generic `wake.correlation.registered` event (ADR 0001); this stage adds the work-topology events, such as:

```text
WorkDependencyAdded
FollowUpWorkCreated
WorkSplit
WorkSuperseded
```

### Stage 3: Build a small graph projection

Use plain files, SQLite, or the existing local projection mechanism.

Support basic queries such as:

- All surfaces linked to a work item.
- All executions linked to a work item.
- Parent, child, dependency, and follow-up work.
- Pull requests and documents linked to work.

### Stage 4: Use the graph for context assembly

Before invoking an agent, collect relevant linked context:

- Current issue or ticket.
- Linked Slack discussion.
- Approved plan.
- Governing ADR.
- Related work.
- Previous executions.
- Affected software entities.

### Stage 5: Connect to the software graph

Link Wake work to Quorum entities and use graph traversal for impact analysis and contextual retrieval.

### Stage 6: Reconsider storage based on query pressure

Move to a specialised graph store only when current storage becomes limiting.

---

## 22. The central distinction

The most important point is not the choice of database or schema.

It is the distinction between three things:

### The work

The durable intent or outcome being progressed.

### The surfaces

The places where the work is represented, discussed, reviewed, or documented.

### The executions

The temporary human or agent attempts that move the work forward.

In shorthand:

```text
Work persists.
Surfaces change.
Executions come and go.
```

Wake currently has many of the required foundations already:

- Durable event streams.
- Explicit lifecycle stages.
- Restart-safe projections.
- External issue integration.
- Agent execution identity.
- Runner abstraction.
- Session resumption.
- Human approval and discussion.

The work-graph concept does not require Wake to abandon those foundations. It gives them a broader interpretation.

The issue stream can remain the current centre of execution while Wake gradually becomes capable of understanding that the same work may exist across GitHub, Jira, Slack, pull requests, documents, decisions, agent sessions, and the software system itself.

---

## 23. Conclusion

Wake began with a practical and valuable interaction model:

```text
Create an issue.
Assign it to the agent.
Review the plan.
Approve.
Receive a pull request.
Continue the discussion.
```

That already treats engineering work as something that progresses asynchronously rather than as a terminal session that must be manually driven.

The work-graph idea extends that model.

It recognises that, as Wake becomes more like a colleague, the work will no longer fit neatly inside one issue or one session. The work will move between planning systems, conversations, documents, source control, execution environments, and production feedback.

A graph is a useful representation because those relationships are not naturally hierarchical or confined to one stream.

Wake’s event-sourced architecture is well suited to this evolution:

```text
Event streams preserve what happened.
Lifecycle projections preserve current control state.
The work graph preserves how everything is connected.
```

The graph should therefore be considered an additional, rebuildable interpretation of Wake’s event history rather than a replacement for the event model.

The immediate value is better correlation and context across surfaces.

The longer-term value is more significant: Wake could become a durable organisational memory of how software work was discussed, decided, executed, reviewed, and connected to the evolving software system.

# Wake Vision

> **Wake is a local autonomous agent control plane for software development.**
>
> It coordinates existing coding agents and deterministic processes to move development work forward through external workflow channels by default, while preserving the ability to resume and directly interact with local agent sessions when needed.

## Concise Summary

Wake exists to make end-to-end development automation practical on a local machine. It should begin as a simple loop that can pick work, decide the next step, invoke the right local tool or deterministic process, persist state, and resume later. If Wake cannot create value in that minimal form, it is difficult to justify adding finer controls, richer lifecycle stages, or more advanced orchestration.

Wake is the control plane and the decider. It owns workflow progression, policy rules, CLI and model selection, token-aware execution choices, deterministic side processes, and session lifecycle management. The local agent sessions it launches are execution contexts, not a second decision-making system.

## Problem

Current coding agents are powerful but operationally awkward when used for sustained development work. They are usually invoked manually, tied to a single CLI surface, and optimized for interactive sessions rather than managed execution over time. That creates friction in the places that matter for end-to-end automation: deciding what should happen next, choosing the right tool and model for each step, preserving state across interruptions, running deterministic housekeeping outside the LLM path, and allowing a human to re-enter a live session locally when direct intervention is the fastest path forward.

The result is that automation either stays shallow or becomes fragile. Simple work still requires too much manual orchestration, while more ambitious flows become expensive, opaque, and difficult to resume safely. Wake exists to close that gap by wrapping existing agent CLIs in a local control plane that can apply scripted routing rules, break work into explicit lifecycle steps, resume or hand off sessions at the right points, and keep deterministic processes out of the token-burning path wherever possible.

## Vision

Wake should become the local control plane for autonomous software development. Its role is not to replace existing coding agents or CLIs, but to coordinate them: selecting the right execution path for each step, deciding when work should be agentic versus deterministic, and managing the lifecycle of work from intake through implementation, validation, handoff, and resumption.

The default operating model should be asynchronous and channel-driven. Work enters and progresses through external systems such as issue trackers, where tasks, status changes, questions, approvals, and results can be managed without requiring a human to sit inside a CLI session. Wake uses those channels as the primary interface for autonomous flow, while running the actual execution locally on the desktop, likely inside containerised sandboxes or similarly isolated environments.

When the higher-level channel is not enough, a human should be able to jump directly into the underlying local CLI session, resume it with context intact, and interact with the agent firsthand. That combination is central to the product: automation should usually happen through durable external workflows, but direct local intervention must remain available as an escape hatch, a debugging tool, and a practical way to complete work without losing context.

Over time, Wake can grow more capable and more adaptive, but its core promise should remain simple: make reliable, resumable, token-aware local agent execution easy enough to use in practice, with issue-driven coordination by default and direct session access when needed.

## What Wake Is

Wake is the system responsible for deciding what should happen next. It owns:

- intake of work from external channels such as GitHub Issues and, later, other systems
- classification of work and progression through explicit lifecycle stages
- deterministic routing rules for which CLI, model, sandbox, and workflow step to use
- execution of non-LLM tasks such as syncing issues, reconciling state, enforcing guardrails, and running health checks
- session lifecycle management, including launch, pause, resume, handoff, and termination
- policy enforcement around token usage, time budgets, and human approval points

Wake should be model-agnostic and CLI-agnostic. Claude Code, Codex, and future tools are execution surfaces that Wake can invoke as part of a broader workflow. The durable intelligence of the system lives in Wake's policies, workflow definitions, state model, and routing rules, not in any single model provider or CLI.

## Agent Sessions

Wake uses local agent sessions for units of agentic execution. A session may correspond to a CLI invocation, a sandboxed container, a transcript, or a resumable execution context associated with a specific objective or lifecycle step.

An agent session is not a persistent worker that sits resident for hours or days waiting for work. Wake starts it for a step, lets it finish, and records enough to bring it back. Equally, Wake should not blindly start a brand-new session for every step. Where continuity is valuable, a later lifecycle stage should be able to resume the same underlying session with its prior context intact, rather than rebuilding understanding from scratch. Whether to resume an existing session or begin a fresh one is a policy decision Wake owns.

This distinction matters because it keeps agency in one place. Wake decides, launches, resumes, and records the execution context.

## Operating Model

Wake should support a staged lifecycle rather than a single opaque agent session. Work may move through steps such as intake, refinement, planning, implementation, validation, review preparation, blocked clarification, and completion. These steps should be explicit enough that Wake can resume work later, hand it off between execution contexts, or switch between deterministic and agentic handling without losing state.

Those lifecycle stages should be configurable rather than hard-coded into Wake. The control plane should provide the machinery for progressing work through stages, but the actual stage model, transitions, and workflow definitions should be pluggable so different repositories or teams can shape the system around their own delivery process.

Wake should own its own execution timing. It runs as a resident local process that drives this loop on a schedule it controls, rather than delegating orchestration to an external operating-system scheduler. Because durable state lives outside the process — on disk and in the external channel — Wake can crash and restart without losing work, rebuilding its picture from that state on startup.

The initial version does not need sophisticated orchestration to prove value. A simple loop is enough:

1. Receive or discover work from an external channel.
2. Determine the current lifecycle step.
3. Apply a deterministic rule set to choose the next action.
4. Either run a deterministic process or invoke the appropriate local agent CLI.
5. Persist the result, update the external channel, and record how to resume.

This loop is the foundation. More granular controls, richer policies, and more advanced lifecycle management should be added only where the basic loop proves insufficient.

## Routing and Policy

Wake should own the rules that determine how execution happens. For the initial product, those rules should be simple, deterministic, and scriptable. They may consider factors such as:

- task classification
- lifecycle stage
- repository or workspace characteristics
- remaining usage limits or token budget
- whether the next step can be handled deterministically
- whether an existing session should be resumed instead of creating a new one

Examples of policy decisions Wake should make include:

- use a cheaper model or shorter-turn workflow for triage and refinement
- use a stronger model only for implementation or other high-value steps
- invoke `claude`, `codex`, or another CLI based on the type of work and local environment
- avoid LLM execution entirely for deterministic jobs such as issue sync, queue reconciliation, validation checks, or state transitions

Wake may become more adaptive over time, but adaptive orchestration is not a requirement for the product to make sense. The first version should stand on deterministic policy alone.

## Core Capabilities

Wake should eventually provide the following capabilities:

- integration with common local agent CLIs rather than replacement of them
- local execution in isolated environments, likely containerised sandboxes
- resumable sessions that can be reopened directly by a human
- channel-driven coordination through issues, comments, and other external systems
- lifecycle-aware handoff between stages or execution contexts
- configurable and pluggable workflows, triggers, and routing rules
- deterministic control-plane actions that reduce token use and increase reliability
- a durable audit trail on the local filesystem — the files Wake writes (state, per-run records, logs, session references, and results) are the record of what the system did and why, and are also how it resumes
- the ability to evolve its own workflows and operating logic in controlled ways over time

For local development environments that run in Docker or similar isolation, Wake should prefer reusing a single durable sandbox instance rather than managing a fleet of separate per-task sandboxes by default. In many cases the isolation boundary needed for work items is the workspace, branch, or worktree rather than a fully separate container for every execution. A separate working folder per work item is an acceptable isolation mechanism where git worktrees are awkward; the setup cost of preparing such a workspace is expected and can be coordinated by the control plane outside the LLM path. Wake should treat multiple concurrent sandboxes as an extension case, not as the baseline operating model.

These capabilities should be developed incrementally, with each layer justified by clear operational value rather than architectural ambition alone.

## Design Principles

### Simple First

Wake must justify itself as a simple loop before it grows into a more elaborate orchestration system. The minimal version should already save time, reduce manual coordination, and make autonomous execution more practical.

### Control Plane, Not Chatbot

Wake should behave like an operations layer for software delivery, not like another conversational assistant. Its primary job is to manage work, policy, state, and execution flow.

### External Channels by Default

The normal interface should be durable external systems such as issue trackers. Humans should not need to sit inside a terminal for the system to remain useful.

### Direct Local Intervention When Needed

When asynchronous coordination is insufficient, a human must be able to jump directly into the underlying local session and continue the work with full context.

### Deterministic Where Possible

Anything that can be done reliably without spending tokens should be done in the control plane. LLM execution should be reserved for steps that genuinely require agentic reasoning or code generation.

### Model and CLI Agnostic

Wake should orchestrate capabilities, not vendors. Providers and tools will change. The control plane should remain stable across those shifts.

### Explicit Lifecycle State

Work should move through named stages with clear resume and handoff semantics. Opaque long-running sessions should be the exception, not the core model.

### Configurable and Pluggable

Agent behaviour, routing rules, workflow steps, lifecycle stages, and triggers should be configurable. The system should be extensible without forcing a rewrite of the control plane.

### Self-Evolving, Carefully

Wake should eventually be able to improve parts of its own operation, especially workflows, policies, and supporting automation. That is a major long-term unlock because it allows the control plane to become better at coordinating work without requiring constant manual redesign. This should be treated as an aspirational capability rather than a dependency of the first version, and any self-upgrade path should remain explicit, reviewable, and bounded by the same control-plane safeguards applied elsewhere.

## Boundaries and Non-Goals

Wake is a personal, local-first tool. It is meant to run on an individual's own machine, coordinating that person's own work — not to be a hosted, multi-tenant, or organisation-wide engineering fleet. A hosted service is a plausible future direction, but it is explicitly outside the scope of this vision; nothing in the first versions should assume or require it.

Wake should not assume that more agent autonomy is automatically better. It is not trying to simulate a fully independent engineering organisation from day one. It is also not trying to replace existing issue trackers, source control systems, or coding CLIs. Those systems remain important surfaces; Wake coordinates across them.

The initial product should also avoid requiring sophisticated learned routing, complex multi-agent behavior, or deep bespoke UI in order to prove value. Those may become useful later, but they are not prerequisites for a justified first version.

## Near-Term Implications

The earliest credible Wake should be able to:

- pick up work from an external source such as GitHub Issues
- progress that work through a small number of explicit lifecycle steps
- invoke a local CLI in a sandboxed environment
- apply deterministic rules for model and CLI selection
- use configurable lifecycle stages and workflows rather than fixed built-in paths
- persist enough execution state to resume later
- update the external channel with questions, status, and results
- let a human resume the exact local session when direct intervention is needed

If Wake can do those things reliably, it has established the basis for additional control surfaces and smarter orchestration. If it cannot, the system should be simplified rather than expanded.

## Naming Rationale

The name "Wake" fits for two reasons. A wake is the visible path and organised movement left behind by something progressing through water. That matches the role of the system: not to do every piece of work itself, but to create directed motion, coordination, and momentum across development activity.

"Wake" also carries the sense of resuming activity or bringing something back into motion. That aligns with one of the system's key properties: work, sessions, and workflows should be able to pause and continue later without losing continuity. The dual meaning is useful because Wake is both the force that creates forward motion and the mechanism that brings execution back to life.

The naming also fits the broader `atolis-hq` theme, where movement, flow, and navigation metaphors help keep system roles distinct without making them feel arbitrary.

> [!NOTE]
> **This is not the accepted plan.** This document is an early-thinking input:
> raw ideas and framing captured before the vision was settled. It is kept for
> provenance only. Where it conflicts with [`../vision.md`](../vision.md) or
> [`../design/implementation.md`](../design/implementation.md), those documents win. In
> particular, the "long-lived, persistent, multi-day worker" framing of Wake and
> the parallel-Wake diagram below have been superseded — see the vision and
> implementation guide for the accepted model.

# Wake Vision

> **Wake is an autonomous engineering control plane.**
>
> It continuously moves software delivery forward by orchestrating long-lived autonomous agents that plan, implement, evaluate and complete engineering work.

---

# Vision

Modern coding agents are exceptional at solving problems, but they remain fundamentally interactive tools. They require humans to start sessions, resume work after usage limits, choose models, manage context and coordinate execution.

Wake exists to remove that operational burden.

Wake continuously monitors engineering work, decides what should happen next, creates autonomous execution contexts, coordinates models and workflows, and drives work to completion with humans participating only when their judgement is required.

Rather than acting as another coding assistant, Wake becomes the operating system for autonomous software engineering.

---

# Core Concepts

## Wake

Wake is the autonomous engineering control plane.

Its responsibilities include:

- Monitoring GitHub Issues (and future work sources such as Jira)
- Prioritising work
- Selecting workflows
- Scheduling execution
- Managing long-running sessions
- Routing work between different LLMs
- Managing human approvals
- Running evaluations
- Recovering from failures
- Producing pull requests
- Completing work autonomously

Wake decides **what should happen next**.

It is intentionally model-agnostic.

Claude, Codex, OpenAI or future models are simply execution engines available to Wake.

---

## Agent Session

An agent session is a persistent autonomous engineering worker managed by Wake.

An agent session owns a single objective.

It may:

- analyse requirements
- write code
- run tests
- ask for clarification
- review code
- update documentation
- pause
- resume days later
- switch between different models

Wake maintains the identity.

The underlying model is an implementation detail.

Every issue is ultimately completed by one or more agent sessions.

---

# Philosophy

Wake should behave less like an AI chatbot and more like an engineering platform.

Humans create objectives.

Wake determines execution.

Agent sessions perform the work.

---

# Architecture

```text
                GitHub / Jira
                      │
                      ▼
                 +-----------+
                 |   Wake    |
                 | Control   |
                 |   Plane   |
                 +-----------+
                  │    │    │
          ┌───────┘    │    └────────┐
          ▼            ▼             ▼
      +-------+    +-------+     +-------+
      | Wake  |    | Wake  |     | Wake  |
      +-------+    +-------+     +-------+
          │            │             │
   Claude / Codex / OpenAI / Future Models
          │            │             │
          └────────────┴─────────────┘
                       │
                       ▼
              Commits • PRs • Reviews
```

---

# Why "Wake"?

A wake is the organised movement created by an object travelling through water.

It represents:

- progress
- movement
- coordination
- propagation
- momentum

Wake is the force that continuously moves engineering work forward.

It does not perform every task itself.

Instead, it creates the conditions for autonomous execution.

---

# Agent Sessions

Wake creates agent sessions.

Each session is:

- autonomous
- persistent
- self-contained
- long-lived
- capable of adapting as conditions change

Each session forms, performs useful work, exchanges information with the wider system and eventually dissipates once its purpose has been fulfilled.

---

# Design Principles

## Model Agnostic

Wake should never depend on a particular LLM.

Models will improve.

New providers will emerge.

Wake should orchestrate capability, not vendors.

---

## Long-Lived Execution

Engineering work often takes hours or days.

Agent sessions should survive:

- model usage limits
- machine restarts
- Docker recreation
- host failures
- human interruptions

Execution should resume naturally.

---

## Human in the Loop

Humans should provide:

- objectives
- priorities
- approvals
- clarification
- strategic decisions

Everything else should be automated where possible.

---

## Workflow Driven

Wake should execute reusable workflows rather than bespoke prompts.

Examples include:

- Feature implementation
- Bug fixing
- Refactoring
- Dependency upgrades
- Code review
- Documentation
- Security remediation
- Architecture analysis

Workflows should evolve independently of the models that execute them.

---

## Observable

Every decision should be visible.

Wake should provide:

- execution history
- reasoning
- evaluation results
- model usage
- costs
- timelines
- audit trails

Autonomous systems must be transparent before they can be trusted.

---

# Future Direction

Wake should evolve into a complete autonomous engineering platform.

Potential capabilities include:

- Multi-agent collaboration
- Planning and decomposition
- Background execution
- Automatic model routing
- Cost optimisation
- Evaluation-driven development
- Human approval gates
- Distributed execution
- Multiple repositories
- Organisation-wide engineering automation

Ultimately, Wake should become the control plane for autonomous software engineering.

---

# Relationship to Corum

The Atolis ecosystem separates understanding from execution.

| Product            | Responsibility                       |
| ------------------ | ------------------------------------ |
| **Corum**          | Understand software and architecture |
| **Wake**           | Change software autonomously         |
| **Agent sessions** | Execute autonomous engineering work  |

Corum provides knowledge.

Wake provides orchestration.

Agent sessions provide execution.

Together they create an engineering platform that understands software and continuously improves it.

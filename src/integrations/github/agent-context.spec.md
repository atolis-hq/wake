# GitHub Agent Context — Component Specification

## Type, purpose, and scope

Adapter. This component implements Activities' `AgentContextReader` contract
for GitHub: given a WorkItem, it returns the correlated GitHub object's
current title/body and its full comment history, purely by refolding
already-recorded `integration.github.*` evidence — it makes no live GitHub
call of its own.

## Responsibilities and boundaries

This component owns resolving a WorkItem's primary GitHub resource, folding
that resource's `integration.github.work-observed` evidence to its latest
title/body, and folding its `integration.github.comment-observed` evidence
to an ordered comment history. It does not poll GitHub — GitHub Inbound
Evidence does, and this component only reads what that evidence already
recorded. It does not decide what an agent does with this context — this
component supplies read-only facts to whatever caller composed it as an
`AgentContextReader`.

## Core policies, invariants, and behaviours

- A WorkItem with no primary-correlated resource, or whose resource cannot
  be found, MUST report empty title/body and no comments rather than error.
- The reported title/body MUST be the payload of the resource's own most
  recent `integration.github.work-observed` event matching its external
  key, folded in journal order; an object never observed reports empty
  title/body.
- The reported comment history MUST include every `integration.github.comment-observed`
  event whose external key matches the resource, in journal order, each
  entry carrying the comment/review's own author, occurrence time, and body
  — regardless of `reviewKind` (`formal` or `issue`).
- Every fold this component performs MUST be re-derivable purely from the
  adapter's own `integration` stream; this component holds no state of its
  own between calls.

## Conceptual schema

**CommentHistoryEntry**

| Field | Type | Description |
| --- | --- | --- |
| `author` | string | The comment or review's own actor id, as GitHub reported it. |
| `occurredAt` | timestamp | When the comment or review was recorded as evidence. |
| `body` | string | The comment or review's own body text. |

## Dependencies and system role

- GitHub Inbound Evidence (this component depends on it) — the sole source
  of the `integration.github.*` evidence this component folds; this
  component never calls the GitHub API itself.
- Resources (this component depends on it) — `correlationsForWork` and
  `get` resolve a WorkItem's primary GitHub resource and its external key.
- Activities' Agent execution (depends on this component) — composed
  directly by Bootstrap as GitHub's `AgentContextReader`, outside
  Integrations' own `ProviderInstance` contract, to build an agent run's
  prompt context.

## Decisions, exclusions, and deferred capability

- This component is wired into Activities' agent execution by Bootstrap's
  composition root, not through Integrations' `ProviderInstance`; it has no
  `maintenance` cycle and is not part of the poll/inbound/delivery loop
  every other GitHub component participates in.

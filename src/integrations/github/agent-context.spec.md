# GitHub Agent Context — Component Specification

## Type, purpose, and scope

Adapter. This component implements Activities' `AgentContextReader` contract
for GitHub: given a WorkItem, it returns the correlated GitHub object's
current title/body and a bounded, causally relevant comment delta, purely by refolding
already-recorded GitHub evidence and durable delivery facts — it makes no
live GitHub call of its own.

## Responsibilities and boundaries

This component owns resolving a WorkItem's primary GitHub resource, folding
that resource's `integration.github.work-observed` evidence to its latest
title/body, and folding its `integration.github.comment-observed` evidence plus
confirmed comment-shaped delivery intents to an ordered comment history. It
does not poll GitHub — GitHub Inbound Evidence does, and this component only
reads durable facts already recorded. It does not decide what an agent does
with this context — this
component supplies read-only facts to whatever caller composed it as an
`AgentContextReader`.

## Core policies, invariants, and behaviours

- A WorkItem with no primary-correlated resource, or whose resource cannot
  be found, MUST report empty title/body and no comments rather than error.
- The reported title/body MUST be the payload of the resource's own most
  recent `integration.github.work-observed` event matching its external
  key, folded in journal order; an object never observed reports empty
  title/body.
- The agent-facing context retains at most 12 newest eligible comments, excluding
  historical Wake deliveries while retaining the latest Wake reviewer rejection
  and the latest Wake agent handoff.
  Each retained comment is capped at 8,000 characters and all retained bodies at
  48,000 characters, with truncation marked explicitly.
  The reconciled source history includes every `integration.github.comment-observed`
  event whose external key matches the resource, in journal order, each
  entry carrying the comment/review's own author, occurrence time, and body
  — regardless of `reviewKind` (`formal` or `issue`).
- The reconciled source history also includes each primary-resource `status.publish`,
  `reply.publish`, or `agent-run.publish` intent once its delivery is confirmed
  (including a reconciled confirmation). Its synthetic body MUST be exactly the
  GitHub-delivered body, including delivery markers and the configured web
  public URL in an agent-run report; its author is
  `unknown-github-identity` and its timestamp/order key is the earliest
  confirmation's occurrence time/global position.
- Synthetic delivery history applies to the built-in GitHub adapter and every
  enabled integration adapter configured with provider `github`; it never
  treats an unrelated provider's delivery as a GitHub comment.
- A provider-observed comment whose delivery marker identifies such an intent
  MUST replace its synthetic entry before `observedSince` filtering, while
  retaining the synthetic confirmation's timestamp and ordering key. Matching
  is scoped to the same resource. Failed, pending, ambiguous, and non-comment
  deliveries do not appear in history.
- Every fold this component performs MUST be re-derivable from the journal;
  this component holds no state of its own between calls.

## Conceptual schema

**CommentHistoryEntry**

| Field | Type | Description |
| --- | --- | --- |
| `author` | string | The comment or review's own actor id, as GitHub reported it. |
| `occurredAt` | timestamp | When the comment or review was recorded as evidence. |
| `body` | string | The comment or review's own body text. |

## Dependencies and system role

- GitHub Inbound Evidence (this component depends on it) — provides provider
  observations this component folds; this component never calls the GitHub API
  itself.
- Durable Delivery (this component depends on it) — provides confirmed
  outbound comment facts before their later inbound observation.
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

# Agent Run Publication — Component Specification

## Type, purpose, and scope

Policy/process. Agent Run Publication replays terminal agent-run facts from
Execution and projects each into exactly one durable `agent-run.publish-requested`
delivery intent per run, addressed to the run's workflow's primary Resource,
so an agent's own outcome reaches its provider through the same delivery
pipeline as every other outbound fact.

## Ubiquitous language

- **Terminal agent run** — a run whose activity is the built-in Agent
  activity and whose `RunSucceeded`/`RunFailed` fact has already been
  recorded; only such a run is projected.
- **AgentRunPublicationReport** — the provider-neutral rendering of one
  terminal agent run: its runner/model identity, timing, outcome, display
  body, session/workspace identity, and (when applicable) its awaiting-
  approval or watch-gate-verdict framing.

## Responsibilities and boundaries

This component owns replaying `execution.run-succeeded`/`execution.run-failed`
facts once each, checkpointed; resolving each terminal run's workflow
instance and primary Resource; determining the run's activation's own stage
and whether its workflow is currently awaiting an approval-shaped signal;
detecting whether the run's own outcome is the verdict a parent watch is
waiting on; and recording one `agent-run.publish-requested` fact per run,
addressed to that Resource's own stream. It does not decide the report's
provider-specific rendering (that is each provider's outbound translator,
e.g. GitHub's comment formatter) and does not itself deliver anything — the
Delivery aggregate does, once the Delivery Intent Projection surfaces the
recorded fact.

## Core policies, invariants, and behaviours

- Events since this component's own checkpoint MUST be processed in the
  order the journal returns them, and the checkpoint MUST advance to each
  event's own journal position whether or not it was a terminal run fact.
- A run whose activity is not the built-in Agent activity, or that has no
  `finishedAt`, MUST be skipped — no intent is recorded.
- A terminal run whose workflow instance cannot be resolved, or whose
  WorkItem has no `primary`-correlated Resource, MUST be skipped.
- The recorded fact's own event id MUST derive deterministically from the
  run's own id, so a repeated fold of the same terminal fact — including
  after a crash before the checkpoint advanced — MUST NOT record a second
  intent for the same run; a rejected duplicate append MUST be treated as
  already-recorded, not as an error.
- The report's `stage` MUST be the stage the workflow instance entered
  before requesting the activation this run belongs to, found by scanning
  that workflow instance's own history backward from the matching
  activation request; a report with no resolvable stage omits the field.
- The report's `awaitingApproval` MUST be set when the workflow instance is
  currently waiting on an approval-shaped signal.
- The report's `watchGateVerdict` MUST be set, naming this run's own id,
  only when: the run's own agent outcome is `DONE` or `REJECTED`; the
  workflow instance is a watch's spawned child; and its parent workflow
  instance is currently waiting on a watch-gate-verdict signal naming that
  same child's watch. Any other case omits the field.
- The report's `displayBody` MUST be the run's own agent display body when
  non-empty, else the run's own failure message when non-empty, else a
  fixed fallback string; its `outcome` MUST be the run's own agent outcome,
  defaulting to `FAILED` when the run recorded no agent result at all.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `execution.run-succeeded` / `execution.run-failed` | Read since the last checkpoint, for a terminal Agent-activity run | A candidate agent-run report now exists to project into a delivery intent. |
| `agent-run.publish-requested` | This component records a terminal run's own report | A durable delivery intent now exists for the run's own outbound report. |

## Conceptual schema

**AgentRunPublicationReport**

| Field | Type | Description |
| --- | --- | --- |
| `runId` | Run identity | The terminal run this report describes. |
| `stage` | string (optional) | The workflow stage active when the run's activation was requested. |
| `runner`, `runnerPool`, `cli`, `model` | string (optional) | The run's own runner identity, when recorded. |
| `startedAt`, `finishedAt` | timestamp | The run's own start/finish times. |
| `displayBody` | string | The rendered outcome text; see Core policies above. |
| `outcome` | closed vocabulary: `DONE` / `REJECTED` / `BLOCKED` / `FAILED` | The run's own agent outcome, or `FAILED` when none was recorded. |
| `sessionId` | string (optional) | The run's own resumable session id, when the agent recorded one. |
| `workspacePath` | string (optional) | The run's own workspace path, when recorded. |
| `metadata` | map of string to string/number/boolean/null | The run's own agent-reported metadata (tokens, cost, and provider-specific fields), passed through unchanged. |
| `awaitingApproval` | boolean (optional) | Set when the workflow instance is currently waiting on an approval-shaped signal. |
| `watchGateVerdict` | `{ runId }` (optional) | Set when this run's own outcome is the verdict a parent watch is waiting on; see Core policies above. |

## Dependencies and system role

- Execution (this component depends on it) — `RunRepository`, to load each
  terminal run's own view and its agent/runner/workspace detail.
- Orchestration (this component depends on it) — `listAll` and the
  workflow instance's own event history, to resolve the run's workflow, its
  activation's stage, its waiting state, and any parent/child watch
  relationship.
- Resources (this component depends on it) — `correlationsForWork`, to
  resolve the run's workflow's primary Resource and its own stream.
- Kernel — event journal append/read and the checkpoint store this
  component's replay loop uses.
- Delivery Intent Projection (depends on this component) — folds the
  `agent-run.publish-requested` fact this component records into a
  `DeliveryIntentView` alongside every other intent kind.
- Each provider's own outbound translator (depends on this component,
  indirectly through the projected view) — renders the recorded
  `AgentRunPublicationReport` into that provider's own outbound shape (e.g.
  GitHub's comment formatter).

## Decisions, exclusions, and deferred capability

- This component's checkpoint name is fixed
  (`reactor:agent-run-publication`); only one instance is expected to run
  per Wake home today.

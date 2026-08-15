# Schedule Policy and Service — Component Specification

## Type, purpose, and scope

Policy/process. `SchedulePolicy` is the pure computation of which
minute-granularity cron slots have elapsed for one schedule since its last
checkpoint. `ScheduleService` is the process that turns each elapsed slot
into a created WorkItem, a started WorkflowInstance, and an advanced
checkpoint.

## Ubiquitous language

- **Elapsed slot** — one whole UTC minute, since the schedule's last
  checkpoint (exclusive) up to and including the current minute, that
  matches the schedule's cron expression.
- **Checkpoint** — the timestamp of the last slot this schedule has fully
  processed, persisted per schedule id via `ScheduleCheckpointStore`.

## Responsibilities and boundaries

`SchedulePolicy` owns computing the ordered list of elapsed slots for one
schedule from its cron expression, the current time, and its last
checkpoint. `ScheduleService` owns, per elapsed slot, minting a new WorkItem
identity, deriving a deterministic WorkflowInstance identity, calling Work's
create command and Orchestration's start command, and advancing the
checkpoint. Neither component decides whether a schedule is currently
enabled or owns retry/backoff for a failed slot — a caller invokes `run`
once per schedule per host cycle.

## Core policies, invariants, and behaviours

- A schedule's cron expression MUST have exactly five whitespace-separated
  fields (minute, hour, day-of-month, month, day-of-week); `elapsedSlots`
  MUST throw otherwise.
- `SchedulePolicy` delegates expression parsing and occurrence calculation to
  `cron-parser`, constrained to Wake's five-field form. Lists, ranges, steps,
  and `JAN`-`DEC`/`SUN`-`SAT` aliases are supported; invalid expressions MUST
  throw instead of being treated as never matching.
- Occurrences are evaluated in UTC, never in the deriving process's local
  timezone. A seconds field or time-zone configuration is not part of Wake's
  schedule interface.
- When no checkpoint is recorded for a schedule, `elapsedSlots` MUST
  evaluate only the current minute, never backfilling any prior history.
- When a checkpoint is recorded, `elapsedSlots` MUST evaluate every whole
  minute strictly after the checkpoint up to and including the current
  minute, in ascending order, and MUST return an empty list when the
  checkpoint's minute is not before the current minute (including when the
  checkpoint is in the future relative to `now`).
- Each elapsed slot's identity MUST be `schedule:<scheduleId>:<slot ISO
  timestamp>`, deterministic and stable for the same schedule and minute.
- `ScheduleService.run` MUST process elapsed slots in ascending time order,
  and for each slot MUST mint a new WorkItem identity, call Work's create
  command with the schedule's configured objective, call Orchestration's
  start command for the schedule's configured workflow with a
  slot-deterministic WorkflowInstance identity
  (`workflow-<slot-timestamp, filesystem-safe>`), then save the checkpoint
  to that slot's timestamp, before moving to the next slot.
- The command context for each slot's create/start calls MUST derive its
  `commandId` and `correlationId` from the caller's context suffixed by the
  slot's own identity, so distinct slots never share a command identity even
  within the same `run` call.
- A crash between a slot's `orchestration.start` call and that slot's
  checkpoint save is not recovered idempotently: the WorkItem identity for a
  slot is minted fresh on every `run` call, so re-processing an
  unchecked-pointed slot after such a crash creates a second, distinct
  WorkItem for the same slot. The WorkflowInstance identity for a slot is
  deterministic, so a re-processed slot's `orchestration.start` targets the
  same instance identity as before; whether that second call is accepted as
  a no-op or rejected is Orchestration's own command-acceptance policy, not
  something this service decides.

## Conceptual schema

**ScheduleSlot** (per `elapsedSlots` call; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `identity` | string | `schedule:<id>:<at>`; stable per schedule and minute. |
| `at` | timestamp | The elapsed minute's ISO timestamp. |

**ScheduleCheckpointStore** (contract this service depends on)

| Field | Type | Description |
| --- | --- | --- |
| `load(scheduleId)` | timestamp or null | The last fully-processed slot's timestamp for this schedule, or `null` if none yet. |
| `save(scheduleId, slot)` | — | Advances the checkpoint to the given slot's timestamp. |

## Dependencies and system role

- Work (dependency) — `ScheduleService` calls its create-WorkItem command
  for each elapsed slot.
- Orchestration (dependency) — `ScheduleService` calls its
  start-WorkflowInstance command for each elapsed slot.
- Kernel — IdGenerator for the minted WorkItem identity, and command-context
  conventions.
- Would-be dependent: a schedule-running host, none of which composes this
  service today.

## Decisions, exclusions, and deferred capability

- `ScheduleService` is implemented but not invoked by any composed host;
  `controlPlane.schedules` is validated configuration with no consumer
  today. Composing it into a repeating host is a deferred capability, not a
  rejected one.

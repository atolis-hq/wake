# Cron Parser Schedule Policy Design

## Goal

Replace Wake's bespoke cron-field matcher with `cron-parser` while preserving
the durable schedule-slot contract: five-field expressions, UTC evaluation,
checkpoint-based catch-up, and stable slot identities.

## Scope

The change is confined to Control Plane's `SchedulePolicy`, its direct tests,
the package dependency manifest, and current schedule documentation. It does
not compose schedules into a host, add a time-zone configuration field, or
delegate checkpointing, work creation, workflow starts, or deduplication to
the library.

## Design

`SchedulePolicy.elapsedSlots` will retain its current signature and return
shape. It will first require exactly five whitespace-separated fields so Wake
continues to reject six-field/second-based expressions. It will parse the
expression with `cron-parser` using `tz: 'UTC'` and iterate matching
occurrences strictly after the checkpoint (or only the current minute when no
checkpoint exists) through the current minute inclusively.

The policy will convert each returned occurrence to an ISO UTC timestamp and
derive the existing `schedule:<schedule-id>:<timestamp>` identity. `ScheduleService`
will remain unchanged: it owns persistent checkpoints and its existing
idempotent processing behaviour.

The parser will not be put into strict mode. `cron-parser` strict mode requires
six fields and rejects expressions with both day-of-month and day-of-week;
neither rule matches Wake's established five-field public contract. The
documentation will state the library grammar supported by this five-field
subset, including ranges and month/day names, and will continue to promise UTC
evaluation. Time-zone/DST-specific behaviour remains a future configuration
feature, not a new option in this change.

## Validation

Focused unit tests will prove range expressions, named month and weekday
fields, invalid expressions, checkpoint exclusivity/current-minute inclusion,
and UTC behaviour when the host process timezone differs. The existing restart
scenario will remain green. Documentation tests and formatting/build checks
will guard package and documentation changes.

## Risks and Mitigations

The library broadens accepted syntax. Five-field validation limits that
expansion to Wake's documented scheduling granularity, while focused tests and
documentation make the accepted grammar explicit. The new dependency has an
MIT license and supports Node 18+, below Wake's Node 24 minimum.

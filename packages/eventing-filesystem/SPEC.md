---
asOf: 5031f5b26b684460a94bb1b97599813cc14c5926
---

# Eventing Filesystem — Package Specification

## Purpose and scope

Eventing Filesystem implements Eventing ports with Node filesystem APIs. It
preserves the established Wake disk format without knowing any Wake domain
event, configuration, or home-path policy.

## Responsibilities and boundaries

The package owns the flat JSONL journal codec and storage, journal wake-up
support, checkpoints, rebuildable projection records, processor-owned state,
atomic writes, storage-name validation, locks, and per-consumer run
serialisation. It does not own Eventing contracts or runtime policy, domain
facts, `.wake` path resolution, Bootstrap composition, or a new infrastructure
service.

## Ubiquitous language

- **Data root** — caller-supplied directory containing Eventing records.
- **Projection record** — a rebuildable namespaced/keyed read model with its
  last global position.
- **Processor-state record** — opaque processor recovery data identified by
  consumer and key; it is not a projection.
- **Run serialisation** — exclusive execution for one processor consumer.

## Core policies, invariants, and behaviours

- A file journal MUST preserve expected-sequence append semantics, stream and
  global order, and the established flat JSONL event representation.
- Checkpoints MUST be monotonic per consumer and use compatible established
  records when a Wake home already contains them.
- Projection records MAY be cleared and rebuilt from the journal.
- Processor-state records MUST remain separate from projections and be read and
  written atomically under their consumer/key identity. Established compatible
  locations and record representations remain readable so a Wake home needs no
  migration.
- Locks and atomic writes MUST prevent a partially written record becoming a
  successful durable result. Run serialisation MUST prevent concurrent passes
  for the same consumer.

## Public surface and dependencies

The package root is its only supported import path; normal composition uses the
Eventing adapter constructors it exports. The package depends on
`@atolis-hq/eventing` and Node APIs; Bootstrap, not this package, selects a
data root and composes adapters into Wake.

## Decisions, exclusions, and deferred capability

The package provides no domain event decoder, Wake source compatibility
surface, data-migration command, alternate delivery runtime, database adapter,
or new infrastructure service.

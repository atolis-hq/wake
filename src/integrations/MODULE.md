# integrations

## Purpose

Provider adapters, typed event processors, translation, delivery, and
reconciliation.

## Owns

Payload contracts, external queries, provider polling, translators, delivery,
processor selectors, idempotent integration handlers, and reconciliation.

## Does not own

Canonical Work, Resource, Activity, or workflow policy; Eventing host
construction; or concrete serialisation.

## Invariants

Inbound evidence becomes typed commands and durable facts. Outbound facts use
durable delivery. Provider processors have stable consumers and use bounded
poll watermarks; delivery reconciliation remains separate from incremental
processor handling.

## Public contracts

`index.ts` is the only public entry.

## Configuration

Owns `integrations`.

## Relations and events

Owns `integration.` evidence, provider-neutral `status.` and `reply.` intents,
and `delivery.` facts, including their streams.

## Failure and recovery

Processor failures retain their Eventing checkpoints and report health.
Provider poll watermarks, surface diagnostics, and bounded reconciliation
checkpoints are independent operational state.

## Extension rules

Provider types stay here; validate external payloads at the boundary and let
domains validate proposed commands. Define processors here, but Bootstrap
constructs the host, serialiser, and complete registry.

## Scenarios

E2E-WORK-002, E2E-PR-001, E2E-DELIVERY-001.

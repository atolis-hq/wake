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

Reported child PRs are verified against the producing Run's selected repository,
branch, resulting HEAD and logical PR base. Verification never transfers primary
ownership. Ambiguous verification retains the existing bounded reconciliation
path; confirmed mismatches cannot register a qualifying output.

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

Prerequisite outputs distinguish verified pushed changes, delivery-ready review
and check authority, and actual provider-observed merge state at the exact head.
They retain observed base revisions for selective downstream freshness checks;
workflow or issue completion is never merge evidence.

Governed integration reuses provider artifact verification for exact repository/branch/head/base
identity and the target's own review/check authority. Maintained subjects need fresh trusted
review evidence from the maintenance Run onward. Existing delivery intents/results reconcile
child-owned merges to the requesting parent's wait without transferring correlation.

Maintained PRs with required checks need provider execution evidence for the exact head/base
subject, with every reported check or status started after the new maintenance subject was recorded. A retained
`passing` value, re-polling an older execution, missing timestamps or incomplete provider evidence
cannot satisfy this gate. Check evidence is journaled even when the aggregate state remains
`passing`, and the same subject and execution-time rules apply after restart.

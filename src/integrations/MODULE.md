# integrations

## Purpose
Provider adapters, typed event reactors, translation, delivery, and reconciliation.
## Owns
Payload contracts, external queries, formatting, translators, and delivery.
## Does not own
Canonical Work, Resource, Activity, or workflow policy.
## Invariants
Inbound evidence becomes commands; outbound facts use durable delivery.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `integrations`.
## Relations and events
Owns `integration.` evidence, provider-neutral `status.` and `reply.` intents, and `delivery.` durable delivery facts, including the `integration` and `delivery` streams.
## Failure and recovery
Integration reactors define stable `reactor:*` event processors and keep their
selectors and event decoding inside Integrations. Delivery outcomes explicitly
include confirmed, failed, and ambiguous; bounded reconciliation is separate
from incremental processor handling.
## Extension rules
Provider types stay here; domains validate all proposed commands.
## Scenarios
E2E-WORK-002, E2E-PR-001, E2E-DELIVERY-001.

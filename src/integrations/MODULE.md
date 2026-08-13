# integrations

## Purpose
Provider adapters, translation, delivery, and reconciliation.
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
Delivery outcomes explicitly include confirmed, failed, and ambiguous.
## Extension rules
Provider types stay here; domains validate all proposed commands.
## Scenarios
E2E-WORK-002, E2E-PR-001, E2E-DELIVERY-001.

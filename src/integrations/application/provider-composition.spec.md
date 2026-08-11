# Provider Composition & Inbound Polling — Component Specification

## Type, purpose, and scope

Adapter. This component composes operator configuration into running
`ProviderInstance`s (the provider registry), and ingests one provider's
polled evidence into that provider's own durable `integration` stream,
idempotently.

## Ubiquitous language

- **Provider type** — a registered `ProviderDefinition` (e.g. `github`,
  `fake`), identified by its own `provider` name.
- **Adapter instance** — one configured, composed use of a provider type,
  named by its config entry's own key unless the entry overrides `provider`.

## Responsibilities and boundaries

This component owns provider type registration and lookup, turning
`integrations` configuration into composed `ProviderInstance`s, and generic
idempotent evidence ingestion onto the `integration` stream. It does not
translate evidence into commands — that is each provider's own
`InboundTranslation`. It does not decide eligibility or tags — that is the
module's intake-rule vocabulary, applied by each provider's own translator.

## Core policies, invariants, and behaviours

- Registering two provider types under the same `provider` name MUST be
  rejected.
- Composing configuration MUST produce an instance only for enabled config
  entries; a disabled entry produces no instance and is not an error.
- A config entry's provider type MUST resolve from its own `provider` field
  when present, otherwise from the config entry's own key (its adapter
  name); composing an entry whose resolved provider type is not registered
  is an unrecoverable configuration error and MUST throw, taking the whole
  composition call down with it.
- A registered provider type whose own `create` call throws (e.g. bad
  config, an unreachable credential) MUST NOT take composition down with
  it: that entry's failure MUST be collected, by adapter name, provider
  name, and the thrown error's own message, and composing every other
  entry MUST still proceed to completion.
- Ingesting an evidence draft whose event type is not among the composed
  instance's own declared `eventTypes` MUST be rejected.
- An evidence draft MUST be appended to its adapter's `integration` stream
  only when no event with that draft's event id already exists on that
  stream; a provider re-reporting the same evidence MUST NOT duplicate it.

## Conceptual schema

**ProviderInstance**

| Field | Type | Description |
| --- | --- | --- |
| `adapter` | Adapter identity | This instance's own configured name. |
| `source` | ExternalEventSource | Polled for new evidence drafts each cycle. |
| `delivery` | ExternalDeliveryAdapter | Performs and reconciles this adapter's outbound effects. |
| `inbound` | InboundTranslation | Turns this adapter's evidence into commands. |
| `eventTypes` | list of event type | The closed set of event types this instance may emit; anything else is rejected. |

**ProviderCompositionResult** (`compose`'s own return value)

| Field | Type | Description |
| --- | --- | --- |
| `instances` | list of ProviderInstance | Every entry that composed successfully. |
| `failures` | list of `{ adapter, provider, error }` | Every enabled, registered entry whose own `create` call threw, and why. |

## Dependencies and system role

- Kernel — event journal read/append for evidence ingestion; this
  component's only dependency for the ingestion half of its role.
- GitHub's provider definition and the fake provider's definition (both
  depend on this component) — each registers a `ProviderDefinition` that
  this component composes from configuration.
- Work Admission and each provider's own inbound translation (depend on
  this component only indirectly, via the evidence it ingests) — this
  component never calls either directly.

## Decisions, exclusions, and deferred capability

- There is no provider hot-reload or de-registration; composition happens
  once from the configuration a runtime is started with.
- Construction failure is deliberately tolerated (collected as a
  `ProviderCompositionFailure`) rather than thrown, because commands that
  do not need that specific provider — `doctor`, `sandbox-setup`,
  `sandbox-entrypoint` — must still run even when one provider cannot
  construct (e.g. missing sandbox credentials); an unregistered provider
  type, by contrast, is a configuration error with no such recovery path
  and still throws.

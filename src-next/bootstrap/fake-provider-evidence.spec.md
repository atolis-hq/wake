# Fake provider evidence hydration — Component Specification

## Type, purpose, and scope

Adapter. Fake provider evidence hydration resolves the fixture files a
`fake`-shaped integration entry references — its recorded inbound events and,
optionally, its recorded delivery effects — into in-memory data attached to
that entry, before providers are composed from the validated configuration.

## Responsibilities and boundaries

This component owns reading and shaping fixture files for fake-provider
configuration entries only. It does not decide which providers are enabled,
does not validate non-fixture integration entries at all, and does not
itself compose a provider instance — it only prepares the data a fixture
provider's composition later reads.

## Core policies, invariants, and behaviours

- Every integration entry MUST be inspected against the fake-provider shape
  (`provider: 'fake'`, a non-empty `evidenceFile`, an optional non-empty
  `effectsFile`). An entry that does not match — including a non-fake
  provider, or a `fake`-typed entry missing `evidenceFile` — MUST pass
  through completely unchanged; this component MUST NOT reject or alter it.
- For a matching entry, `evidenceFile` MUST resolve to a JSON file, relative
  to `wakeRoot`; its parsed contents become that entry's evidence. A missing
  or invalid evidence file MUST fail hydration — there is no fallback for a
  fixture's evidence.
- For a matching entry that also declares `effectsFile`, the file MUST
  resolve the same way and, if present, MUST parse as a flat string-keyed
  record of string values. If the file does not exist, hydration MUST fall
  back to an empty effects record rather than failing; a file that exists
  but does not parse to that shape MUST still fail hydration.
- An entry with no `effectsFile` configured MUST end up with an empty
  effects record and MUST NOT gain an `effectsFile` key at all — resolving a
  path is only observable on the entry when one was configured.
- Every other field already present on a matching entry MUST be preserved
  unchanged alongside the newly attached evidence and effects.
- Hydration runs once, synchronously, as part of composing the application
  graph; its output is transient, in-memory shaping of the validated
  configuration, never a durable fact.

## Conceptual schema

**Hydrated fake-provider entry**

| Field | Type | Description |
| --- | --- | --- |
| `provider` | literal `fake` | Unchanged from the validated configuration entry. |
| `evidenceFile` | non-empty string | Unchanged; the resolved path is not written back onto the entry. |
| `effectsFile` | non-empty string, present only if configured | Rewritten to its resolved absolute path when originally configured; absent otherwise. |
| `events` | fixture inbound events, as parsed from `evidenceFile` | Consumed by the fake provider's poll/inbound behaviour. |
| `deliveryEffects` | record of string to string | Consumed by the fake provider's delivery behaviour; empty when no effects file was configured or found. |

## Dependencies and system role

- Root configuration (depends on this component's input) — this component
  only ever operates on an already-validated integrations configuration.
- Composition root (depends on this component) — runs hydration before
  composing providers, so a fake provider's composition can assume its
  evidence and effects are already resolved data rather than file paths.

## Decisions, exclusions, and deferred capability

- Only entries shaped exactly like a fake-provider entry are hydrated; a
  live (non-fixture) provider entry is never inspected or altered by this
  component, regardless of its own configuration shape.
- There is no fixture-evidence caching across composition roots — hydration
  re-reads both files every time an application graph is composed.

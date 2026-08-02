# GitHub Inbound Evidence — Component Specification

## Type, purpose, and scope

Adapter. This component polls GitHub for issues and pull requests, and
normalizes and deduplicates them into `integration.github.work-observed`
evidence event drafts on the adapter's own `integration` stream, without
deciding eligibility or minting any Wake identity.

## Ubiquitous language

- **External key** — a GitHub issue or pull request's own locator,
  formatted `owner/repo#number`.
- **Revision** — an issue's own `updated_at` timestamp, or a pull request's
  head commit sha (falling back to its own `updated_at` when GitHub reports
  no sha).
- **Fingerprint** — a hash of a pull request observation's own fields plus
  its fetched check-run/commit-status evidence, used as part of that
  observation's own event id.
- **Check evidence availability** — whether check-run and commit-status
  evidence could be fetched at all for a given poll; unavailable evidence
  reports `unknown` checks rather than a stale prior value.

## Responsibilities and boundaries

This component owns turning one GitHub issue or pull request — plus, for a
pull request, its check runs and commit statuses — into one
`integration.github.work-observed` draft, per-repository polling isolation,
and ETag-based conditional-GET caching for branch lookups. It does not
decide whether an observation is eligible for admission or what tags it
carries — that is GitHub Inbound Translation, applied after this
component's evidence lands on the stream. It does not mint any Wake
identity.

## Core policies, invariants, and behaviours

- One configured repository failing to poll MUST NOT prevent any other
  configured repository's issues or pull requests from polling in the same
  cycle; the failing repository's evidence for this cycle is simply
  omitted.
- An issue payload that carries a pull-request marker MUST be excluded from
  issue polling; every pull request is observed once, through pull-request
  polling, never also as an issue.
- An issue observation's event id and revision MUST derive from the issue's
  own `updated_at` timestamp; polling the same issue state again (same
  `updated_at`) MUST produce the same event id, so it is not re-appended.
- A pull request observation's event id MUST derive from a fingerprint of
  its own observed fields plus its fetched check-run/commit-status
  evidence, so a check-state-only change — with every other field
  unchanged — still produces new, distinct evidence.
- A pull request's checks state MUST be `unknown` when check evidence could
  not be fetched this poll. When evidence was fetched, checks state MUST be
  `failing` if any check or status failed, else `pending` if any is still
  pending, else `passing` if any passed, else `unknown`.
- A pull request's `state` MUST report `merged` when the provider reports a
  merge timestamp, regardless of the provider's own open/closed state
  field.
- A branch lookup MUST reuse its cached response, keyed by repository and
  branch name, when the provider's conditional-GET response indicates the
  cached value is still current (HTTP 304); any other error propagates.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `integration.github.work-observed` | A poll observes an issue or pull request, first seen or changed since last polled | A candidate for admission or an existing Resource's state update now exists as evidence. |

## Conceptual schema

**ExternalWorkObservedPayload** (this component's own evidence shape)

| Field | Type | Description |
| --- | --- | --- |
| `externalKey` | `owner/repo#number` | The GitHub object's own locator. |
| `kind` | closed vocabulary: `issue` / `pull-request` | Which GitHub object shape this evidence describes. |
| `title`, `body` | string | The object's current title and body. |
| `state` | closed vocabulary: `open` / `closed` / `merged` | Current lifecycle state as observed. |
| `revision` | string | See Revision above. |
| `headRevision`, `baseRevision` | string (optional) | Pull-request-only; head/base commit shas. |
| `checks` | closed vocabulary: `unknown` / `pending` / `passing` / `failing` (optional) | Pull-request-only; current aggregate checks state. |
| `actor` | id + kind (`human`/`bot`) | Who last touched the object, as GitHub reports it. |
| `labels`, `assignees` | list of string (optional) | Current label and assignee names, when available. |
| `raw` | opaque record | The provider's own object number, retained for downstream tracing. |

## Dependencies and system role

- Provider Composition & Inbound Polling (depends on this component) —
  ingests this component's evidence drafts through its generic idempotent
  append.
- GitHub Inbound Translation (depends on this component) — the sole
  consumer of `integration.github.work-observed` evidence.

## Decisions, exclusions, and deferred capability

- GitHub review evidence (a pull request's individual reviews) is not
  polled by this component; the review-observation builder that would
  produce `integration.github.comment-observed` from a fetched review
  exists but has no client call feeding it, so it is not part of a
  reachable poll cycle today.
- The etag-cached branch lookup this component exposes is not currently
  called from any composed poll path; it is available for a future
  base-branch or mergeability check.
- A second, GitHub-specific poll class exists alongside this component's own
  `ExternalEventSource` but is not part of the composed GitHub provider: the
  provider is driven by Provider Composition & Inbound Polling's generic
  poll loop instead. Only that class's `ExternalEventSource` type is
  reused; its own poll/append logic is not part of the reachable GitHub
  polling path.

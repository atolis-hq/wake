# GitHub Inbound Evidence — Component Specification

## Type, purpose, and scope

Adapter. This component polls GitHub for issues, pull requests, pull-request
reviews, and issue/PR comments, and normalizes and deduplicates them into
`integration.github.work-observed`/`integration.github.comment-observed`
evidence event drafts on the adapter's own `integration` stream, without
deciding eligibility or minting any Wake identity.

## Ubiquitous language

- **External key** — a GitHub issue or pull request's own locator,
  formatted `owner/repo#number`.
- **Revision** — an issue's own content fingerprint, or a pull request's
  head commit sha (falling back to its own `updated_at` when GitHub reports
  no sha).
- **Fingerprint** — a hash of an issue or pull request observation's own
  fields — for a pull request, plus its fetched check-run/commit-status
  evidence — with Wake's own `wake:`-prefixed labels excluded, used as part
  of that observation's own event id so republishing those labels never
  looks like an external change.
- **Check evidence availability** — whether check-run and commit-status
  evidence could be fetched at all for a given poll; unavailable evidence
  reports `unknown` checks rather than a stale prior value.
- **Outcome** — an issue's closed disposition, derived from the provider's
  own close reason: `not_planned` maps to `cancelled`, any other closed
  reason (including none) maps to `completed`. Undefined while open.

## Responsibilities and boundaries

This component owns turning one GitHub issue or pull request — plus, for a
pull request, its check runs and commit statuses — into one
`integration.github.work-observed` draft; turning one pull-request review or
one issue/PR comment into one `integration.github.comment-observed` draft;
per-repository polling isolation; poll throttling; and ETag-based
conditional-GET caching across every list/get call it makes. It does not
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
- An issue observation's event id and revision MUST derive from a
  fingerprint of its title, body, state, outcome, actor, labels (excluding
  Wake's own), and assignees; the same observed content MUST produce the
  same event id, so it is not re-appended, and republishing only Wake's own
  labels MUST NOT change the fingerprint.
- A pull request observation's event id MUST derive from a fingerprint of
  its own observed fields (labels likewise excluding Wake's own) plus its
  fetched check-run/commit-status evidence, so a check-state-only change —
  with every other field unchanged — still produces new, distinct evidence.
- A poll call MUST return no drafts when called again before its
  configured `lookbackMs` interval has elapsed since the previous poll; an
  issue or pull-request draft whose event id is unchanged since this
  process's last poll of that same external key MUST also be omitted, as a
  same-process perf optimization on top of the journal's own idempotency —
  neither omission is a correctness dependency, and both reset on restart.
- A pull request's checks state MUST be `unknown` when check evidence could
  not be fetched this poll. When evidence was fetched, checks state MUST be
  `failing` if any check or status failed, else `pending` if any is still
  pending, else `passing` if any passed, else `unknown`.
- A pull request's `state` MUST report `merged` when the provider reports a
  merge timestamp, regardless of the provider's own open/closed state
  field.
- A comment whose body is empty or whitespace-only MUST produce no
  evidence draft.
- Every list or get call this component makes (issues, pull requests,
  reviews, issue comments, a single issue's labels, a single pull request,
  a branch) MUST reuse its cached response, keyed by its own request
  identity, when the provider's conditional-GET response indicates the
  cached value is still current (HTTP 304); any other error propagates. A
  paginated call spanning more than one page MUST NOT cache its result,
  since a single per-key etag cannot validate a multi-page response.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `integration.github.work-observed` | A poll observes an issue or pull request, first seen or changed since last polled | A candidate for admission or an existing Resource's state update now exists as evidence. |
| `integration.github.comment-observed` | A poll observes a pull-request review (`reviewKind: 'formal'`) or an issue/PR comment (`reviewKind: 'issue'`), first seen since last polled | A candidate review or command signal now exists as evidence for GitHub Inbound Translation. |

## Conceptual schema

**ExternalWorkObservedPayload** (this component's own evidence shape)

| Field | Type | Description |
| --- | --- | --- |
| `externalKey` | `owner/repo#number` | The GitHub object's own locator. |
| `kind` | closed vocabulary: `issue` / `pull-request` | Which GitHub object shape this evidence describes. |
| `title`, `body` | string | The object's current title and body. |
| `state` | closed vocabulary: `open` / `closed` / `merged` | Current lifecycle state as observed. |
| `outcome` | closed vocabulary: `completed` / `cancelled` (optional) | Set only once the issue is closed; see Outcome above. |
| `revision` | string | See Revision above. |
| `headRevision`, `baseRevision` | string (optional) | Pull-request-only; head/base commit shas. |
| `checks` | closed vocabulary: `unknown` / `pending` / `passing` / `failing` (optional) | Pull-request-only; current aggregate checks state. |
| `actor` | id + kind (`human`/`bot`) | Who last touched the object, as GitHub reports it. |
| `labels`, `assignees` | list of string (optional) | Current label and assignee names, when available. |
| `raw` | opaque record | The provider's own object number, retained for downstream tracing. |

**GitHubCommentObservedPayload** (this component's own comment/review evidence shape)

| Field | Type | Description |
| --- | --- | --- |
| `reviewKind` | closed vocabulary: `formal` / `issue` | `formal` for a pull-request review; `issue` for an ordinary issue or PR comment. |
| `externalKey` | `owner/repo#number` | The commented-on object's own locator. |
| `body` | string | The comment or review's own body text. |
| `revision` | string | The comment/review's own timestamp, used for dedup. |
| `actor` | id + kind (`human`/`bot`) | Who authored the comment or review. |
| `resourceAuthorId`, `authorization` | string / authorization evidence (optional, `formal` only) | The reviewed object's author, and the reviewer's own trust evidence. |
| `raw` | opaque record | The provider's own comment or review id, retained for downstream tracing. |

## Dependencies and system role

- Provider Composition & Inbound Polling (depends on this component) —
  ingests this component's evidence drafts through its generic idempotent
  append.
- GitHub Inbound Translation (depends on this component) — the sole
  consumer of `integration.github.work-observed` and
  `integration.github.comment-observed` evidence.

## Decisions, exclusions, and deferred capability

- The etag-cached branch lookup this component exposes is not currently
  called from any composed poll path; it is available for a future
  base-branch or mergeability check.
- A second, GitHub-specific poll class exists alongside this component's own
  `ExternalEventSource` but is not part of the composed GitHub provider: the
  provider is driven by Provider Composition & Inbound Polling's generic
  poll loop instead. Only that class's `ExternalEventSource` type is
  reused; its own poll/append logic is not part of the reachable GitHub
  polling path.

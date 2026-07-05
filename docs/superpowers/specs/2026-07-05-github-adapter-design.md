# Wake GitHub Adapter Design

## Goal

Add the first real GitHub-backed intake path to Wake so the control plane can
poll configured repositories, synchronize relevant issue state locally, decide
when work is needed, and invoke Eddy through the existing runner seam.

## Scope

This design covers the first real-source integration for Wake:

- a GitHub source configuration surface
- a polling GitHub adapter that reads issues and comments
- config-driven pickup policy based on repository and labels
- local synchronization through normalized Wake event envelopes
- policy-driven Eddy invocation when new or changed work requires action
- minimal outbound GitHub status publication for active, blocked, and done work
- support for `fake` and fixed-model `claude` runner modes

This design explicitly excludes:

- webhook ingestion
- dynamic model selection
- GitHub Checks, Projects, or richer workflow integrations
- multi-source coordination beyond GitHub
- Docker or container environment bootstrapping

## Design Summary

Wake will keep GitHub-specific behavior behind adapter seams while retaining
product logic inside the control plane. A GitHub source adapter will poll one or
more configured repositories, apply coarse server-side filtering where possible,
compare fetched snapshots with Wake's local state, and emit normalized inbound
events only for newly discovered or changed items.

Wake policy will remain responsible for deciding whether work is needed. When an
eligible issue is new, receives a new human comment, or becomes newly eligible
through a label or state change, Wake should claim work, prepare a workspace,
invoke Eddy using the configured runner mode, persist the run, and publish a
minimal GitHub status update.

The transport for this milestone should be an Octokit-based client that derives
its token from `gh auth token` at startup. This keeps authentication aligned
with the already-authenticated local GitHub CLI while avoiding a large
subprocess wrapper around `gh` for normal GitHub API operations. Direct
`gh api` usage remains an escape hatch for edge cases where Octokit is awkward
or incomplete.

GitHub synchronization should run inside the normal tick path, not in a
separate background sync loop. The resident loop should only schedule ticks.
That keeps source polling, event persistence, projection rebuilds, candidate
selection, and Eddy invocation inside one durable, lock-protected control-plane
cycle.

## Architecture

### Transport choice

The GitHub integration should use:

- `gh auth token` to resolve the active GitHub CLI credential once at startup
- an Octokit client constructed from that token
- direct `gh api` only as a fallback path when required by a specific endpoint
  or operational quirk

This is preferred over wrapping `gh` for all operations because Wake needs
structured polling, snapshot comparison, pagination, comment publication, and
conditional request support. Those concerns fit a real HTTP client more cleanly
than a command-wrapper layer while still reusing the existing authenticated
account.

### Module boundaries

The new code should preserve existing control-plane boundaries:

- `src/adapters/github/`
  - token resolution through `gh auth token`
  - Octokit client creation
  - polling and normalization logic
  - outbound GitHub publication logic
- `src/core/`
  - policy decisions about whether work is needed
  - candidate selection from synchronized local projections
- `src/domain/`
  - config schemas and event payload shapes for GitHub-sourced data
- `src/adapters/fs/`
  - durable storage for source cursors and projection-backed sync state

The GitHub adapter should not choose lifecycle stages or runner behavior. It
should only fetch, normalize, and publish.

## Configuration

Wake should keep runner choice static and config-driven for this milestone.

### Runner configuration

The existing runner configuration should remain the source of truth:

- `runner.mode = fake | claude`
- `runner.claude.model` for a fixed model such as `haiku`
- existing Claude command, session, and smoke settings

Wake should not determine models dynamically in this slice.

### GitHub source configuration

Add a `sources.github` configuration section with fields equivalent to:

- `enabled`
- `repos`
  - list of `owner/repo` sources
- `polling`
  - `maxIssuesPerRepo`
  - `commentPageSize`
  - `lookbackMs`
- `policy`
  - `requiredLabels`
  - `ignoredLabels`
- `publication`
  - optional active label
  - whether to post status comments

`scheduler.intervalMs` remains the resident-loop polling cadence. The GitHub
adapter should not introduce a separate scheduler or background sync daemon.

## Polling And Efficiency

The adapter should use efficient coarse filtering without owning business policy.

### Source-side filtering

At fetch time, the adapter should filter by:

- configured repository
- open issues only
- label constraints where server-side filtering is available
- updated-since or equivalent coarse watermark filtering where practical

This filtering is an efficiency optimization only. Wake policy remains the final
authority on whether an issue is actionable.

### Credential and client startup

At process startup or first GitHub use:

1. run `gh auth token`
2. fail clearly if token resolution fails
3. construct an Octokit client
4. use that client for all normal GitHub reads and writes

Wake should surface an explicit startup or adapter error when `gh` is not
installed or not authenticated.

### Incremental sync strategy

Wake should persist both:

- a source-level last successful poll watermark
- per-issue sync metadata derived from local projections or dedicated source
  metadata

The polling algorithm should:

1. query candidate issues changed since the last successful poll, with a small
   configurable lookback window to reduce missed updates from clock skew or
   delayed writes
2. fetch the issue details needed for canonical projection fields
3. fetch comments only for candidate issues, using pagination limits that keep
   prompts and API usage small
4. compare fetched issue and comment snapshots to the local synchronized state
5. emit normalized events only for changes Wake has not already recorded
6. advance the source watermark only after a successful poll-and-persist cycle

Where GitHub endpoint behavior supports conditional requests, the adapter should
use them. Local snapshot comparison remains the correctness backstop even when
watermarks or conditional headers are used.

### Long-term note

The design should explicitly acknowledge that a hybrid source model may be
needed later. If repository volume, rate limits, or synchronization cost grows,
Wake may need to push more coarse filtering or change detection into the source
adapter while still keeping lifecycle and runner decisions inside core policy.

## Event Model And Local Sync

The GitHub adapter should emit normalized Wake events rather than writing state
files directly.

### Inbound event types

The first pass should support event types equivalent to:

- `github.issue.upsert`
- `github.issue.comment.created`
- `github.issue.comment.updated`

Each event should include:

- repo and issue identity
- relevant comment identity where applicable
- canonical issue or comment payload fields needed by projections and policy
- `occurredAt` from GitHub when available
- `ingestedAt` from Wake
- optional raw fragments for diagnostics

The projection updater should continue to own derived per-issue state material.

### Local synchronization contract

Wake should treat the local per-issue state as the synchronized mirror used for
deterministic routing. The GitHub adapter should compare remote snapshots
against that mirror and emit only new or changed events.

This keeps the data flow consistent:

1. poll GitHub
2. normalize changed data into event envelopes
3. append inbound events
4. rebuild projections
5. let policy decide whether work is needed

## Policy And Eddy Invocation

Policy should decide whether synchronized change requires work. The adapter
should not make this decision.

### Eligibility rules

An issue is eligible when all of the following are true:

- the issue is open
- the issue belongs to a configured repository
- the issue contains all configured required labels
- the issue contains none of the configured ignored labels

### Work-needed triggers

Wake should invoke work when it sees one of these cases:

- a newly discovered eligible issue
- a new human comment on an existing eligible issue after Wake last acted
- an issue that becomes eligible because labels or state changed

The policy layer should use synchronized projections plus newly ingested events
to detect those cases. It should not repeatedly invoke Eddy for unchanged items
on every poll.

### Tick flow

The existing tick runner should remain structurally the same:

1. poll inbound events from the GitHub adapter
2. persist inbound events
3. rebuild projections
4. select an actionable candidate
5. write a `running` run record
6. prepare workspace
7. invoke Eddy through the configured runner
8. persist run completion state and resulting events
9. publish minimal outbound GitHub status

The main policy enhancement is candidate selection based on actionable change,
not just on the current lifecycle stage.

For this milestone, the tick is also responsible for triggering GitHub sync. A
separate intake loop would add coordination and race complexity without
improving the first production proof.

## Outbound GitHub Publication

Outbound publication should stay deliberately small in this milestone.

Wake should support:

- a short comment or marker when work is claimed
- a short comment when Eddy returns `BLOCKED`
- a short comment when Eddy returns `DONE`
- optional application of a lightweight configured label for active handling

Wake should not implement richer GitHub surfaces such as Checks or Projects in
this slice.

## Testing Strategy

The GitHub integration should add focused tests without disturbing the existing
skeleton contract coverage.

### Required tests

1. token acquisition
   - successful `gh auth token` resolution initializes the GitHub client
   - a failed token lookup produces a clear startup or adapter error
2. incremental sync
   - newly seen issues emit normalized issue events
   - unchanged issues emit no duplicate events
   - new human comments emit comment events
   - already-synced comments do not re-emit
3. policy-triggered execution
   - a newly eligible issue triggers Eddy exactly once
   - a new human comment on an existing eligible issue triggers or resumes work
   - an unchanged eligible issue does not trigger repeat work
4. outbound publication
   - blocked and done results produce the expected GitHub publication requests
5. runner selection
   - the same GitHub intake path works with `fake`
   - the same GitHub intake path works with fixed-model `claude`

Tests should isolate GitHub transport behind mocks or a fake GitHub client while
still exercising the real projection and tick flow.

## Implementation Sequence

The implementation should proceed in this order:

1. extend config schema for GitHub source and policy settings
2. add GitHub token resolution through `gh auth token`
3. add an Octokit-backed GitHub client wrapper
4. implement polling and normalization into Wake event envelopes
5. persist poll watermark and sync metadata
6. extend policy to detect actionable new or changed work
7. add minimal outbound GitHub publication
8. cover the new flow with tests using `fake` and fixed-model `claude`

## Risks And Guardrails

- Do not move lifecycle or runner selection logic into the GitHub adapter.
- Do not make polling correctness depend only on timestamps; keep local snapshot
  comparison as the final authority.
- Do not introduce dynamic model routing in this milestone.
- Do not add webhook handling and container bootstrapping to the same slice.
- Do not split GitHub polling into a separate background loop in this
  milestone.
- Do not assume the thin adapter model will scale indefinitely; document the
  future hybrid option clearly, but do not implement it now.

## Acceptance Criteria

This milestone is complete when:

- Wake can authenticate to GitHub by deriving a token from `gh auth token`
- one or more configured repositories can be polled on the resident interval
- label-based eligibility is configurable
- new or changed eligible issues synchronize into local Wake state through
  normalized events
- Wake invokes Eddy only when policy determines work is needed
- Wake can run the flow with either `fake` or fixed-model `claude`
- Wake publishes minimal outbound GitHub status for active, blocked, or done
  work
- the design notes clearly record that a hybrid intake model may be needed later
  for scale or efficiency

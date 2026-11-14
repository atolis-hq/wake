# Wake Live Runtime Parity — Corrective Packet Design (25A / 25B)

**Supersedes for planning purposes:** the single-packet scope in
`2026-07-31-wake-live-runtime-parity-correction-design.md` §8.
**Evidence base:** Appendix A of this document.
**Review inputs:** `2026-07-31-wake-live-runtime-parity-correction-design-review.md`.
**Status of this document:** point-in-time design record (historical; not a reference doc).
**Operator decisions recorded:** 2026-07-31.

---

## 1. Why this document exists

The corrective design and its review resolved eight operator decisions and four
required changes, then scoped the work as a single Task 25A described as "no new
domain capability — only composition wiring of already-built modules".

Direct comparison of `src/` and `src-next/` does not support that scope. Three
areas — prompt templates, runner fidelity, and GitHub state synchronization —
are roughly 2,000 lines of legacy behaviour with essentially no target
implementation, and two defects (provider-derived WorkItem identity, and an
inbound/outbound external-key mismatch that breaks every delivery) must be fixed
before anything is wired, because both change durable event payloads.

This document records the operator decisions that resolve those questions and
splits the work into two packets with independent gates.

## 2. Operator decisions — 2026-07-31

These extend, and do not reopen, decisions 1–8 in the review §2.

**D9 — WorkItem identity is always minted.** A WorkItem id is a minted ULID.
External references are carried exclusively through Resources. Source adapters
supply freeform title and metadata, with a small set of common fields to make
that usable. Internal ids are what get passed around.

**D10 — Reverse lookup is served by journal-folded projections.** Minting removes
the ability to derive an id from an external key, so external-key lookup becomes
load-bearing. It is served by two projections registered in
`runtimeProjectionDefinitions`, not by a hand-maintained mapping store. This is
the conscious decision that "avoid dedicated mapping tables" required.

**D11 — Work is split into two packets.** 25A proves the loop is real against the
fake boundary. 25B delivers provider and runner fidelity plus manual real-GitHub
acceptance. Task 26 blocks on both.

**D12 — Labels are strictly a provider concern.** The domain emits a typed,
provider-neutral work-state intent. The provider owns the marker vocabulary and
the transport. The reconciliation policy is written provider-agnostically but
sited inside the GitHub namespace until a second provider needs it.

**D13 — Configuration decides routing; providers supply facts.** Adapters do not
propose workflows. Adapter config assigns tags at intake; Orchestration selectors
match those tags. Tags are first-class on the WorkItem.

**D14 — Cost bounds are operator-controlled and never overridden.** `maxTurns` is
optional in prompt frontmatter. If absent, the flag is not passed to the runner at
all. If present, it is passed verbatim — Wake does not inject a default and does
not clamp the value. Clamping would remove control from the user. The wall-clock
timeout is a runner/execution config setting with a default, adjustable by the
operator and likewise not clamped.

**D15 — Providers are instances, not types.** The `integrations` map key is an
adapter id and `provider` defaults to it, so multiple instances of one provider
type are expressible. The adapter id is a workflow-selector criterion alongside
tags, which makes an instance a policy boundary rather than merely a second
credential (§12.3).

**D16 — Approval is wait acceptance authority, not an auto-approval flag.** What
may satisfy a wait is first-class and closed: `human`, `auto`, or a named `watch`.
Auto-approval requires both a workflow-declared capability and durable per-item
operator consent. `allowAutoApproval` moves out of prompt frontmatter, because an
agent prompt must not be able to widen approval authority (§12.6).

## 3. Identity model (D9, D10)

### 3.1 What is wrong today

`integrations/github/application/inbound-translator.ts:217` mints
`work-github-<owner>-<repo>-<number>`, and `:213` mints the matching
`resource-github-...`. This contradicts ADR-0001, `CLAUDE.md`, and catalogue
WORK-INTAKE and WORK-LIFECYCLE simultaneously, and puts the literal `github`
inside durable `work.*` and `resource.*` stream ids. The identity brand does not
prevent it: `work/contracts/identifiers.ts:6` accepts `/^work-[a-z0-9-]+$/`.

### 3.2 Target model

- WorkItem id: minted ULID, `work-<ulid>`. Never derived from any external value.
- Resource id: minted ULID, `resource-<ulid>`. The external system appears only as
  `ExternalResourceKey { adapter, key }` on the Resource record.
- Correlation is the only link between the two, and is already modelled
  (`resources/domain/correlation.ts`, catalogue RESOURCE-CORRELATION).
- Identity brands are tightened to reject provider-derived shapes, so a
  regression fails at construction rather than becoming durable state.

Intake becomes: look up the external key; if a Resource exists, correlate to its
existing WorkItem; otherwise mint both and correlate. Idempotency comes from the
lookup, not from a reconstructable id.

### 3.3 Common intake fields

Adapters supply freeform title and metadata plus a small closed set of common
fields, so that Work, routing, and the surfaces have something stable to use
without parsing provider payloads:

| Field | Purpose |
| --- | --- |
| `objective` | Human-readable title, freeform, provider-supplied |
| `kind` | Resource kind (open registry — `issue`, `pull-request`, later `message`) |
| `capabilities` | Closed capability vocabulary already modelled in Resources |
| `adapter` | Opaque provider id |
| `tags` | Operator-assigned classification, see §5 |
| `externalKey` | Provider-owned locator, see §4 |

Anything beyond this stays provider-specific and is not interpreted outside the
provider's own namespace.

### 3.4 Lookup projections (D10)

Two lookups are on the hot path once ids are minted, and both are full journal
scans today:

- `resources/application/resource-repository.ts:37-55` — `findByExternalKey`
  reads the entire journal, collects every discovered resource id, then re-folds
  each resource stream to compare external keys. Called once per observed object.
- `resources/application/resource-service.ts:83-97` — `correlationsForWork` does
  the same scan plus per-resource re-fold, then filters. Called on every
  `advanceOnce`.

Both are replaced by projections registered in `runtimeProjectionDefinitions`:

| Projection | Key | Value |
| --- | --- | --- |
| `resources-by-external-key` | `${adapter}:${key}` | `resourceId` |
| `work-correlations` | `workItemId` | correlated `resourceId`s with roles |

These are pure folds over the same journal, rebuilt by
`validate-state --rebuild-projections` like every other projection. They are a
durable derived index, not a second source of truth. The replay guarantee in
`CLAUDE.md` extends to them: deleting `.wake/state/` and replaying must reproduce
them identically to the live fold.

## 4. External-key grammar

Sources mint `${repository}#${number}` (`issue-source.ts:19`, `pr-source.ts:76`),
producing `owner/repo#42`. `outbound-translator.ts:26-38` parses
`key.split('/')` against a three-element tuple, expecting `owner/repo/42`. Every
delivery to a resource the system observed therefore throws
`Invalid GitHub resource key` — the intake-to-delivery round trip cannot complete.

The same function forces `pull_number` for all four intent kinds, so issue-thread
status and reply publication is structurally impossible, against INT-PUBLISH.

**Resolution.** The provider owns one grammar and exposes parse and format
functions; neither direction splits key strings inline. Delivery targets are
resolved by resource kind and capability, not by assuming a pull request. This
defect is invisible to unit tests because inbound and outbound are tested against
separately authored fixtures, so §7 requires a scenario that delivers to the
identity intake created.

## 5. Routing (D13)

### 5.1 Split

Adapter config owns **eligibility and tagging** — which external objects become
observations, and what tags they carry. Provider vocabulary (labels, channels,
branches) is legitimate here, inside the provider's own subtree, per corrective
design §5.

Orchestration config owns **routing** — which workflow a tagged WorkItem enters,
per catalogue ORCH-TRANSITION.

```yaml
integrations:
  <provider>:
    intake:
      - where: { labels: [bug] }
        tags: [bug]
      - where: { kind: pull-request }
        tags: [review]

orchestration:
  workflowSelectors:
    - match: { tags: [review] }
      workflow: review
    - match: { tags: [bug] }
      workflow: default
  default: default
```

### 5.2 Semantics

- Tags are assigned at intake by an operator-authored rule. They are Wake-owned
  data, not a passthrough of provider labels.
- Tags are first-class: carried on the intake command, stored on the WorkItem,
  projectable, API-queryable, and visible in the UI.
- Match mode applies to both `where` and `match`, with the same meaning in each.
  Default is `any`; `all` is opt-in.
- The mode governs matching **within** a list. Separate keys are always AND-ed, so
  `{ kind: pull-request, tags: [bug, urgent] }` means a pull request **and**
  (`bug` **or** `urgent`).
- First matching selector wins, then the configured default — legacy behaviour,
  `docs/workflows.md:115`.
- Adapters never propose a workflow name. Configuration is the only routing
  authority.

### 5.3 Echo-loop invariant

Intake rules must not tag from Wake-owned marker families. Without this, Wake
publishes `wake:status.working`, the adapter observes the label, the tag set
changes, the selector re-routes, and Wake publishes again. This is the feedback
loop legacy already solved with `expectedEcho` and the `<!-- wake:agent -->`
marker, arriving by a new route. The exclusion is enforced by construction, not
by convention.

## 6. Provider state synchronization (D12)

Three concerns are separated:

| Concern | Owner |
| --- | --- |
| Policy — reconcile Wake's marker families against the external set, replacing only what Wake owns and preserving every other user marker | Provider-agnostic pure function |
| Vocabulary — `wake:status.*`, `wake:stage.*`, `wake:workflow.*` | GitHub provider |
| Transport — the API call | GitHub provider |

The policy is the dangerous part and contains no provider content: it is set
arithmetic over families, and getting it wrong silently deletes an operator's own
labels (`github-issues-work-source.ts:799-814`).

It is nonetheless **sited inside `integrations/github/**` for now**, written as a
pure function with no GitHub types in its signature. Building a shared capability
against a single real provider is speculative generality, which catalogue
`FUTURE-PLUGIN-PLATFORM` already dispositions `remove`. Siting it this way makes
later extraction a file move plus a registration rather than a redesign. A new
`defer` catalogue row records the extraction trigger: the second provider that
needs it.

**Two consequences.**

The delivery intent must carry typed state, not a rendered body.
`integrations/delivery/contracts/intents.ts` currently gives both
`StatusPublishRequested` and `ReplyPublishRequested` a `body: string`, meaning the
domain formats the message and the provider merely posts it — against corrective
design §3.3, which assigns formatting to the provider.

State sync is gated on capability, not on having labels. A provider with no marker
concept maps the identical intent onto a native status field. The required
non-GitHub fake provider proves the seam by syncing state a *different* way, not
by sharing the reconciler.

## 7. Packet split (D11)

### 7.1 Task 25A — the live loop is real

Fake provider boundary only. No real GitHub in any automated tooling
(review decision 8).

| # | Step |
| --- | --- |
| 1 | Minted identity, tightened brands, lookup projections (§3) |
| 2 | Provider-owned external-key grammar; delivery targets by capability (§4) |
| 3 | Provider-neutral intake seam: relocate the poll/intake port out of `integrations/github/**`, re-type the fake against it, provider-keyed config map (review RC-2) |
| 4 | Value-level GitHub locality check (§8) |
| 5 | Register built-in Activities in the composition root |
| 6 | Wire intake, inbound translation, reactors, delivery drain, and projection catch-up into the composed runtime |
| 7 | Tags, selectors, and workflow start for new WorkItems (§5) |
| 8 | Fairness, dispatch cap, operator pause gate, schedule, recovery and liveness hosts |
| 9 | Process-level fake E2E from an on-disk fixture Wake root, covering the review §5 matrix |

**Gate.** A composed process started from an on-disk Wake root observes fake
provider evidence, creates and progresses work, executes a runner, records durable
state, and delivers one fake effect exactly once — plus the review §5
cross-cutting scenarios. `check:catalogue`, `lint:architecture`, `lint:contracts`,
`knip:next`, `verify:next` and `verify` all pass.

### 7.2 Task 25B — provider and runner fidelity

| # | Step |
| --- | --- |
| 10 | Prompt templates from `<wakeRoot>/prompts`: YAML frontmatter parsing, typed validation, and render context (§9) |
| 11 | Runner fidelity: flags, wall-clock timeout, structured output, session capture and resume, token/cost usage, quota-versus-infrastructure failure classification |
| 12 | GitHub state synchronization, echo suppression, outbound idempotency markers, eligibility filtering, watermarks with per-repository fault isolation, ETag-aware polling |
| 13 | Quota pause, reported reset times, alternate eligible runner selection, operator unpause |
| 14 | Manual real-GitHub acceptance script, human-executed |

**Gate.** Manual acceptance evidence recorded per review §7.2, plus catalogue and
documentation audit. Task 26 is blocked until both packets close.

### 7.3 Ordering rationale

Steps 1 and 2 come first because they change durable event payloads; doing them
after wiring means replaying events out. Step 5 precedes any fixture config
because `composition-root.ts:57` constructs an empty `ActivityRegistry` and
`compileWorkflow` resolves stage `activity:` names against it — a Wake root with
any stage cannot load until built-in Activities are registered.

## 8. Locality check must be value-level

The check specified in corrective design §3.4 is a path-scoped grep
(`rg -il github src-next | grep -vi 'github[\\/]'`). By construction it excludes
files under `github/`, so it cannot see GitHub semantics escaping *from inside*
the namespace into domain values — which is exactly how §3.1's defect arose and
survived review.

The static check must additionally assert that no `work.*` or `resource.*`
identifier, stream id, or canonical event payload contains a provider name.

## 9. Prompt templates (D14)

Templates are scaffolded into `<wakeRoot>/prompts` and edited in place by
operators. This matches review §4's `paths` → `remove` disposition, which drops
only the `promptsRoot` custom-location setting.

Frontmatter fields fall into two classes:

- **Optional with no substitution.** `maxTurns` — absent means the flag is not
  passed to the runner; present means it is passed verbatim. Wake neither injects
  a default nor clamps the value (D14).
- **Genuinely nullable.** `model` falls through to the tier's runner; empty
  `allowedTools` means the runner default.

`allowAutoApproval` is **not** a frontmatter field in the target. Approval
authority is declared by the workflow route, not by an agent prompt (D16, §12.6).

The wall-clock timeout is not a frontmatter field. It is a runner/execution config
setting with a default, adjustable by the operator, matching legacy
(`claude-runner.ts:403`).

Because `wake init` is Task 26, the hand-rolled fixture Wake root used by 25A and
25B ships its own `prompts/` directory.

### 9.1 Frontmatter is parsed as YAML and validated

Frontmatter is YAML-shaped but parsed by regex today, and that is silently lossy
in ways an operator cannot see:

- `prompt-templates.ts:32-53` matches `/^([\w.-]+):\s*(.*)$/` per line and skips
  anything else, so `max_turns: 40`, a stray space before a colon, or a YAML list
  vanishes with no error.
- The result is `Record<string, string>`, so consumers string-compare:
  `stage-prompt.ts:319` tests `frontmatter.skipApproval === 'true'`. An operator
  writing `skipApproval: yes` or `True` — both valid YAML booleans — silently gets
  `false`. `:321` has the same shape for `allowAutoApproval`.

The target parses frontmatter with the `yaml` package, already a dependency at
`^2.9.0` and already used by `bootstrap/config/load-config.ts`, then validates the
result against a typed schema.

Forgiving parsing is the wrong default for a file the operator edits by hand,
because it means their edit silently does not take effect. A clear error does not
override the operator's choice; it reports that the choice did not register. Two
mitigations keep strictness from becoming brittle: parse errors name the file and
the issue, and `wake doctor` validates every template, which is already its remit
under catalogue OPS-DOCTOR ("configuration, prompts… customized shipped assets").
A bad edit is therefore caught before a run rather than during one.

All currently shipped templates parse cleanly as YAML. `allowedTools: Bash(git *),
Bash(gh *)` is a plain scalar, since commas are only significant inside flow
collections, and `extraArgs:` yields `null`, which the schema handles.

This work belongs to 25B step 10. It is not deferred: parsing and schema
validation are both already present in the codebase, so the cost is small.

## 10. Documentation consequences

- `CLAUDE.md` states that every runner invocation "must set `--max-turns` and a
  wall-clock timeout — these are the only runaway-cost protections and must not be
  optional." D14 supersedes this for `maxTurns`. The line must be amended in the
  same change, or it remains a false instruction that future work regresses
  against.
- The corrective design §3.1 disposition list (`replicate now` / `adjust` /
  `defer` / `ignore`) still conflicts with `check:catalogue`, which accepts only
  `preserve` / `correct` / `consolidate` / `remove` / `defer`
  (`scripts/check-functional-catalogue.mjs:20`). Review RC-1 remains outstanding.
- Catalogue rows to add: shared state-sync extraction (`defer`), config discovery
  narrowing (`remove`), tags and workflow selectors, and the identity correction.
  Frontmatter validation is `correct` under 25B step 10, not deferred (§9.1).

## 11. Carried assumptions requiring accept or adjust

These are recorded as decisions taken rather than questions asked. Each can be
reversed on review.

| # | Assumption |
| --- | --- |
| A1 | Runner selection is tier-based via `RunnerRegistry`; `createAgentActivity` stops binding a runner at construction and receives one through Execution. Otherwise `execution.tiers` is dead config and two selection models coexist. |
| A2 | Projection catch-up runs once per tick in the host, not inside `advanceOnce`, so batch size stays bounded and the resident loop cannot starve reads. |
| A3 | Config discovery is dispositioned `remove`. The target reads `config.yaml` and `config.workflows.yaml` only, dropping legacy alphabetical multi-file merge and the `config.json` fallback. |
| A4 | `maxFilesChanged` and `blockedPaths` require a changed-files capability on the provider; the fake provider models it, or the policy cannot be proven. |
| A5 | Operator pause and quota pause emit the same `ControlEventType.DispatchPaused` event, differing only in `reason`, so 25B reuses 25A's gate rather than adding a second mechanism. |

## 12. Full target configuration shape

Two files in the Wake root, per A3: `config.yaml` and `config.workflows.yaml`.
Deep-merged, `config.yaml` first. No other discovery.

```yaml
# ---------------------------------------------------------------- config.yaml
schemaVersion: 1

execution:
  agentRunners: # agent transports only (§12.4)
    sonnet:
      kind: claude-cli
      command: claude
      model: claude-sonnet-5
      timeoutMs: 1800000 # wall clock, operator-set, never clamped (D14)
      effort: high # open string; recorded on the Run (§12.4)
      args: ['--add-dir', '/opt/shared'] # passthrough, verbatim
    codex-mini:
      kind: codex-cli
      command: codex
      model: gpt-5.4-mini
      timeoutMs: 1800000
      effort: medium
      args: ['-c', 'sandbox_mode=workspace-write']
    house-agent: # arbitrary executable speaking the agent contract
      kind: command
      command: /opt/wake/bin/my-agent
      args: ['--prompt-file', '{{promptPath}}']
      timeoutMs: 900000
  tiers: # ordered candidates; falls sideways when quota-paused
    standard: [sonnet, codex-mini]
  defaultTier: standard
  leaseDurationMs: 300000
  leaseRenewalIntervalMs: 60000
  transcripts:
    enabled: false
    retentionMs: 259200000 # retained after workspace cleanup

controlPlane:
  resident:
    intervalMs: 60000 # tick cadence
    maxIntervalMs: 300000 # idle-backoff ceiling; any progress resets
  dispatch:
    windowMs: 3600000 # trailing window, counted from durable Run records
    maxDispatches: 20 # circuit breaker across all invocation paths
  schedules:
    - id: nightly-triage
      workflow: triage
      cron: '0 2 * * *'
      objective: Triage untriaged work

integrations:
  github: # key is the adapter id; `provider` defaults to the key
    enabled: true
    token: ${GITHUB_TOKEN}
    repositories:
      - { owner: acme, repo: widgets }
    polling:
      maxPerRepo: 25
      commentPageSize: 25
      lookbackMs: 60000
    intake: # eligibility + tagging (D13, §5)
      - where: { kind: issue, requiredAssignees: [wake-bot], labels: [bug] }
        matchMode: any # any (default) | all — governs within a list
        tags: [bug]
      - where: { kind: pull-request, requiredAuthors: [] }
        tags: [review]
    publication:
      postStatusComments: true
      # wake:* marker families are provider-owned (D12) and not configurable here

surfaces:
  api: { enabled: true, host: 127.0.0.1, port: 4317 }
  web: { enabled: true } # requires api.enabled
```

```yaml
# ------------------------------------------------------ config.workflows.yaml
orchestration:
  retry: # global defaults; per-route `retry:` overrides
    maxFailureRetries: 5
    maxChangesRequestedRetries: 3
  workflowSelectors: # routing authority (D13)
    - match: { tags: [review] }
      matchMode: any
      workflow: review
    - match: { kind: issue, tags: [bug] }
      workflow: default
  default: default # used when no selector matches
  workflows:
    default:
      entry: refine
      commands: # human /commands
        /codereview:
          activity: review.code
          allowedActors: [operator]
          execution: { workspace: read-only, tier: standard }
      watches:
        - id: pr-review
          while: { stages: [implement], statuses: [waiting] }
          on: { events: [execution.run-succeeded] }
          workflow: review
          maxPerGroup: 3
      stages:
        refine:
          activity: agent.refine
          with: { template: refine } # names <wakeRoot>/prompts/refine.md
          execution: { workspace: none, tier: standard }
          on:
            done: { then: implement }
            blocked: { then: blocked }
        implement:
          activity: agent.implement
          with: { template: implement }
          execution: { workspace: branch, tier: standard }
          on:
            done:
              activities:
                - use: pr.approve
                - use: pr.merge
                  with:
                    { method: squash, requireChecks: true, maxFilesChanged: 10 }
              then: done
            failed: { then: implement, retry: { max: 3 } }
```

### 12.1 What changed, and why

| Legacy | Target | Disposition |
| --- | --- | --- |
| `paths` | derived from `wakeRoot`; prompts fixed at `<wakeRoot>/prompts` | `remove` |
| `runners`, `tiers`, `defaultTier` | `execution.*`, unchanged semantics | `preserve` |
| `transcripts` | `execution.transcripts` | `preserve` |
| `retry` | `orchestration.retry` defaults, per-route override | `correct` |
| `scheduler.{intervalMs,maxIntervalMs}` | `controlPlane.resident` | `preserve` |
| `scheduler.dispatchRateLimit` | `controlPlane.dispatch` | `preserve` |
| `sources.github.{polling,pullRequests}` | `integrations.<id>.polling` | `correct` |
| `sources.github.policy` | `integrations.<id>.intake[].where` | `correct` |
| `sources.github.publication` | `integrations.<id>.publication` | `correct` |
| `workflowSelectors` | `orchestration.workflowSelectors` + `default` | `preserve` |
| `commands` | workflow `commands:` with `allowedActors` and `execution` | `correct` |
| `ui.{host,port}` | `surfaces.api` | `correct` |
| `ui.token` | removed; v1 is unauthenticated, loopback-scoped | `remove` |
| `ui.tunnel` | follow-on activity, not config (review decision 7) | `correct` |
| prompt `allowAutoApproval` | `orchestration` route `await.from` (§12.6) | `correct` |
| `wake:auto` label as opt-in storage | WorkItem consent flag; label is provider representation (§12.6) | `correct` |
| `sandbox` | Task 26 | `defer` |
| multi-file `config*.yaml` discovery, `config.json` fallback | two fixed files | `remove` (A3) |

### 12.2 Deltas against what the target validates today

- `integrations` is a provider-keyed map, replacing the hardcoded `github`
  subtree (review RC-2). Each provider's subtree is validated by that provider's
  own schema at registration.
- `execution.runners` currently accepts only `{ kind }`
  (`execution/contracts/config.ts`). It becomes `execution.agentRunners`, a
  discriminated union gaining `command`, `model`, `effort`, `timeoutMs`, and
  passthrough `args` (§12.4).
- `RunView` records nothing about how a Run was executed — no runner identity,
  model, effort, token usage, or cost (`execution/contracts/views.ts:24-42`).
  `RunnerResult` declares `model`, `sessionId`, and `tokenUsage` but nothing
  populates them (Appendix A.3, gap 5). There is therefore no data model for run
  analytics today, and `effort` cannot be recorded until one exists. This is a
  25B step 11 dependency, not a one-field addition.
- `controlPlane.maxDispatches` is currently a flat integer with no window. Legacy
  counts invocations from durable Run records over a trailing window so the
  breaker survives restart; the target needs `windowMs` to match.
- `controlPlane.resident` currently has only `idleBackoffMs`. Legacy has a base
  cadence and a backoff ceiling that any progress resets.
- `orchestration.workflowSelectors`, `default`, and `retry` are new.
- `supplementalCommandConfigSchema` gains an `execution` block (review §6.5).
- `execution.transcripts` is new.

### 12.3 Provider instances (D15)

The provider map key is the adapter id, and `provider` is optional, defaulting to
the key. `github:` therefore needs no discriminator, while multiple instances of
one provider type remain expressible:

```yaml
integrations:
  github-oss:
    provider: github
    repositories: [{ owner: acme, repo: widgets }]
  github-internal:
    provider: github
    repositories: [{ owner: acme, repo: platform }]
```

The adapter id is one of the common intake fields (§3.3), so it is also a
selector criterion. Instances can therefore route to different workflows with no
tags involved:

```yaml
orchestration:
  workflowSelectors:
    - match: { adapter: github-internal }
      workflow: autonomous
    - match: { adapter: github-oss }
      workflow: review-only
  default: default
```

This is why instances are worth having beyond multi-tenancy: an instance is a
policy boundary, not merely a second credential. Legacy could only express this
by tagging every repository's issues identically.

### 12.4 Execution kind, and what a runner is

Execution kind is a property of the **Activity**, not of the runner.
`ActivityExecutionKind` is already a closed vocabulary of
`agent | script | deterministic` (`activities/contracts/vocabulary.ts:4-8`), and
Execution dispatches on it. Only `agent` Activities route through the named
registry and tiers.

That resolves the shape without nesting agent settings under a sub-key:

| Activity `executionKind` | Path | Config home |
| --- | --- | --- |
| `agent` | tier → named runner → transport adapter | `execution.agentRunners` + `execution.tiers` |
| `script` | Execution runs a command directly | the Activity's own `with`, a narrow port |
| `deterministic` | in-process handler | none |

A script Activity therefore never appears in the runner registry. Putting its
command in the Activity's `with` rather than a global registry keeps the target
invariant that activities receive narrow ports, not global state.

The registry is renamed `agentRunners` because the map is already agent-scoped
and the legacy name `runners` does not say so. Tiers, quota pause, session
resume, model selection, prompts, and allowed tools are all agent concepts;
nothing else in Execution consumes them.

**`kind` names the transport adapter, not the vendor.** `claude-cli` and
`claude-api` are different adapters — one takes `command` and resumes with
`--resume`, the other takes `apiKey` and `baseUrl` and has no CLI session. The
registry is therefore a discriminated union on `kind`.

| `kind` | Transport | Variant fields |
| --- | --- | --- |
| `claude-cli` | Claude Code CLI | `command` |
| `codex-cli` | Codex CLI | `command` |
| `cursor-cli` | Cursor CLI | `command` |
| `command` | Any executable speaking the agent contract | `command` |
| `fake` | Deterministic test harness | none |

Future `claude-api` or `codex-api` kinds add a variant carrying `apiKey` and
`baseUrl`, rather than adding optional fields to the CLI variants.

The `command` kind is the extension seam that makes an arbitrary executable a
first-class agent runner. It is distinct from `executionKind: script`: the former
is an agent transport that participates in tiers and returns a structured agent
result; the latter is an Activity that is not an agent at all.

**A field is named when Wake invokes on it, records it, or reports on it.**
Everything else is passthrough `args`, copied to the transport verbatim.

| Field | Shape | Why it is named |
| --- | --- | --- |
| `command` | string | how Wake invokes the transport |
| `model` | open string | recorded on the Run; cost reporting groups by it |
| `effort` | open string | recorded on the Run; cost and outcome analytics group by it |
| `timeoutMs` | integer | enforced by Wake, not by the CLI (D14) |
| `args` | string list | Wake never reads them |

`effort` is core, not vendor trivia. Legacy models it as two fields — `effort`
for Claude, `reasoningEffort` for Codex — but it is one concept, reasoning depth,
spelled differently per transport (`--effort <v>` versus
`-c model_reasoning_effort=<v>`). It is recorded on the Run because a value buried
in an opaque `args` array can never be grouped by, and answering "did higher
effort change outcome quality or cost?" requires it as a first-class field.

**Being first-class does not make it a closed vocabulary.** `model` and `effort`
are open strings. Model names change continuously and vendors add effort levels;
enumerating either would be a maintenance treadmill that breaks the day a vendor
ships a new value, and Wake would then reject a configuration its runner supports.
Wake never branches on these values — it records and groups by them — so an open
string is correct under the contract rule, which requires exported constants for
_closed concepts_ only. This is the same pattern `ResourceKind` already uses: an
open registry that behaviour never tests against a literal.

Wake is therefore not the authority on a transport's permitted range. An effort
level the CLI does not accept fails at that CLI, where the real authority lives,
rather than at Wake's config load.

Passthrough `args` carry everything else. They are per named runner, and a named
runner is already bound to one transport, so nothing is lost by their being
transport-specific: a tier lists distinct named runners, each tuned
independently.

Two guards apply, neither of which is clamping:

- `args` are operator configuration only. They are never templated from agent or
  provider input, and processes are spawned with `shell: false`, as
  `execution/infrastructure/process-execution.ts` already does.
- Flags that Wake's own transport contract depends on — `--output-format` and
  `--resume` — are rejected at config load. Supplying `--output-format text` does
  not tune behaviour; it silently breaks result parsing. This differs in kind from
  `maxTurns`, which is an operator policy Wake must not touch.

### 12.5 Empty module subtrees

`work`, `resources`, and `activities` are `z.object({}).strict()` with
`.default({})` in `bootstrap/config/root-schema.ts`. They accept nothing, so they
are not extension points — an operator writing anything under them gets a
validation error. They are omitted from the documented shape above.

Dropping the three keys from `rootConfigSchema` as well is the tidier option and
is non-breaking, since all three default. The one thing to check first is
`test-next/bootstrap/config-ownership.test.ts`, which exists to prove that each
module validates its own subtree; if it enumerates modules from the root schema,
the keys may be carrying intent beyond their empty shape.

### 12.6 Approval is wait acceptance authority (D16)

Legacy `wake:auto` fuses four concerns. `wake:auto` is an operator opt-in label;
it approves a gate only when the pending action's prompt declared
`allowAutoApproval: true`; `/yolo` and `/autoapprove` only add the label, neither
invoking an agent nor resolving the gate; and when it fires it appends the same
transition a human `/approved` would, recording the decision as `auto:approved`.

The target does not model this as an auto-approval feature. `ORCH-WAIT` already
requires that "only a current accepted signal with matching identity and
**authority** may resume" a wait, so the first-class concept is **what may satisfy
a wait**, and auto-approval is one permitted authority.

#### Why not a route-level boolean

`autoApprove: true` cannot express the cases already on the roadmap: a PR review
satisfying the gate, a review Activity's verdict satisfying it in the
dark-factory chain, or a passing check. A boolean grows `autoApproveIf`, then
`requiredApprovers`, arriving at a general matcher by accident. Acceptance
authority reaches the same place by design, and 25A step 7 builds the wait
contract regardless, so this is not additional scope.

Predicate matching over arbitrary state is deliberately excluded. Authority is a
small closed vocabulary that is exhaustively checkable; predicates become a rules
engine with their own debugging problem. A future "two approvers" requirement is a
count on this contract, not a matcher.

#### Shape

Config is the friendly surface; the compiled type is strict. This follows the
existing `StageConfig` to `CompiledStage` split, with `compileWorkflow` as the
translating and validating boundary.

```yaml
implement:
  on:
    done:
      then: done
      await:
        signal: approval
        from:
          - human # shorthand for { kind: human }
          - { kind: watch, id: pr-review } # that child's verdict, specifically
```

```ts
type ApprovalAuthority =
  | { kind: 'human' }
  | { kind: 'auto' }
  | { kind: 'watch'; watch: WatchId };
```

A discriminated union rather than `{ kind, id? }`, matching the existing
`TransitionTarget`, which names a payload field per variant. A flat optional id
makes illegal states representable in both directions — `{ kind: 'human', id: x }`
is meaningless and `{ kind: 'watch' }` is broken, yet both type-check — forcing
runtime validation to re-assert what the type could have guaranteed. Branding
`WatchId` prevents a stage name being passed as a watch; the union prevents the
reference being absent.

`watch` is a reference, not a fixed `review` type. With more than one reviewer a
fixed type needs an implicit tiebreak such as "most recent verdict wins", which is
the unstated rule `ACT-REVIEW` (`correct`, "verdicts not bound to the reviewed
subject") and `ORCH-CHILD` ("completion is consumed once") exist to remove. A
follow-on activity in `on.<outcome>.activities` is a plausible second referent
later; only the watch is built now, because it is the legacy review shape.

#### Vocabulary

Acceptance authority is a closed vocabulary owned by Orchestration, distinct from
`EventActorKind`. That enum answers who emitted an event — provenance — and
reusing it here reads wrongly: `system` suggests the gate is simply open, hiding
that operator consent is required, and `operator` does not say which human.

| Authority | Satisfied by |
| --- | --- |
| `human` | A person, through any surface: ticket comment, CLI, or UI |
| `auto` | Wake resolving deterministically, **only** when the WorkItem carries operator consent |
| `watch` | The named child workflow's verdict |

`auto` and `watch` are deliberately separate. "I permit Wake to self-approve" and
"I permit a review agent's verdict to count" are different trust decisions.

Provenance is unchanged and recorded separately: the resolving event carries its
`actor` plus a distinct decision provenance, as legacy records `auto:approved`
apart from a human `/approved`. Authority governs the decision; provenance records
it, so an audit can always answer who opened a gate and under what permission.

#### Ownership

Legacy's two-key structure is correct and is retained, relocated to the owners
that D12 and D13 imply. Both keys are required for `auto` to fire.

| Ingredient | Owner | Mechanism |
| --- | --- | --- |
| Capability — this gate _may_ be satisfied by `auto` | `orchestration` | `await.from`, moved out of prompt frontmatter |
| Consent — for this item, the operator permits it | `work` | Durable WorkItem flag, a sibling of freeze/unfreeze under WORK-COMMAND; idempotent set and clear |
| Provider representation | `integrations/<provider>` | `wake:auto` label to and from a neutral signal. A provider without labels uses its own affordance, or offers none |
| `/yolo`, `/autoapprove` | provider signal translation | Reserved control commands like `/approved`, mapping to the Work command rather than to a supplemental activity command |
| The decision and its provenance | `orchestration` | Resolves the wait once, recording `auto` provenance distinctly from human approval |

The consent flag is Wake-owned, not GitHub-owned. Legacy stores the opt-in _as_
the label, which makes a provider the system of record, breaks "the tick is a pure
function of durable state", and leaves a provider without labels unable to express
it. The label becomes the provider's inbound representation of a neutral signal.

It is deliberately not a tag. Tags route (§5); this gates approval. Keeping them
separate also keeps it clear of the §5.3 echo-loop invariant, since re-observing
an already-set flag is a no-op whereas a routing tag flipping would re-route.

#### Consequences

- `allowAutoApproval` leaves prompt frontmatter. An operator editing a prompt can
  currently widen approval authority, which is the boundary `ACT-AGENT` (`correct`)
  exists to fix: agents receive minimal typed context and cannot choose stage or
  policy. This is a behaviour change for anyone who tuned it in a prompt, and needs
  a catalogue row and a documentation note.
- `supplementalCommandConfigSchema.allowedActors` has the same conflation, using
  the provenance enum to answer "who may invoke `/codereview`". `from: [human]`
  reads correctly there too, and one authority vocabulary in both places is
  consistent. This changes an already-built contract, so it is called out
  separately in 25A step 7 rather than assumed.

---

## Appendix A — Evidence base

Direct comparison of `src/` and `src-next/`, and verification of the corrective
design review's claims. Recorded 2026-07-31. Open questions raised by this
analysis are resolved by D9–D16; its proposed sequencing is superseded by §7.

### A.1 Baseline

`npm run verify:next` passes at `rewrite/wake-target-architecture` @ `d9316fa`:
web 7 files / 17 tests, target 119 files / 498 tests, plus `check:catalogue`,
`lint:architecture`, `lint:next`, `format:check:next`, `build:next`.
`npm run knip:next` reports nothing. Legacy `npm run verify` was not run.

### A.2 Verification of the review's claims

| Claim | Result |
| --- | --- |
| C1 — composition root assembles no live loop | Confirmed, with the correction below |
| C2 — GitHub outside the GitHub namespace | Confirmed; exactly the four named production files. Test files are 33, not 32 |
| C3 — fake source is type-coupled to GitHub | Confirmed: `integrations/fake/external-source.ts:1-2` imports from `../github/**` |
| C4 — disposition vocabulary mismatch | Confirmed: `scripts/check-functional-catalogue.mjs:20` |

**C1 needs correcting in both directions.** `TickHost` and `ResidentHost` _are_
constructed in production (`bootstrap/surface-cli-applications.ts:23-24`), and
`src-next/main.ts` is a real entrypoint that loads a Wake root and dispatches
`tick`/`start`/`stop`/`api`/`ui`/`audit`/`correlate`/`validate-state`. Planning as
though no hosts exist would rebuild working code. What is actually absent is
broader than hosts: no registered Activities, no runner registry, no workspace or
transcript ports, no provider intake or delivery, no schedule/recovery/liveness
host, and no continuous projection catch-up.

### A.3 Gap inventory

Each item is a legacy behaviour whose catalogue disposition is `preserve`,
`correct`, or `consolidate`. Items resolved in the body of this document are
cross-referenced rather than repeated.

| # | Gap | Evidence | Resolved by |
| --- | --- | --- | --- |
| 1 | WorkItem identity derived from the provider | `inbound-translator.ts:217`, `:213`; brand at `work/contracts/identifiers.ts:6` permits it | §3 |
| 2 | Inbound and outbound key formats incompatible; round trip cannot complete | `issue-source.ts:19`, `pr-source.ts:76` mint `owner/repo#42`; `outbound-translator.ts:26-38` requires `owner/repo/42` | §4 |
| 3 | Nothing starts a workflow for a new WorkItem | legacy `domain/workflows.ts:184-195`, `docs/workflows.md:115-124`; only production caller of `orchestration.start` is the uncomposed `schedule-service.ts:53` | §5 |
| 4 | No prompt-template capability | legacy `prompt-templates.ts` + `stage-prompt.ts`, 501 lines; `rg -i frontmatter src-next` returns nothing | §9 |
| 5 | Runner adapters lack caps, timeout, session, and quota classification | `claude.ts` 55 lines vs legacy 685; `process-execution.ts` has no timeout; `RunnerResult.sessionId`/`tokenUsage` declared, never populated; `FakeExecutionRunner` does not implement `Runner` | 25B step 11 |
| 6 | GitHub provider owns none of the state-sync semantics §3.3 of the corrective design assigns it | `rg -i label src-next/integrations/` returns nothing; legacy `github-issues-work-source.ts:799-814` (family-preserving label sync), `:28,155-157` (echo marker + self-login), `:33` (idempotency marker), `:226-236` (`expectedEcho`), `:190-196` (assignee eligibility), `:629-651` (watermark, per-repo isolation) | §6, 25B step 12 |
| 7 | `PollService` has no checkpoint or watermark; re-appends its window each poll and does a full `readStream` per draft | `github/application/poll-service.ts` | 25B step 12 |
| 8 | Config discovery narrowed silently | legacy `config/discover-config-files.ts` reads any `config*.yaml` alphabetically; `docs/configuration.md:742-760` documents a `config.json` fallback | A3, §12.1 |
| 9 | Projections never advance in a running process | `projectionRunner`'s only caller is `surface-cli-applications.ts:104-107` | A2, 25A step 6 |
| 10 | `advanceOnce` has no intake, reactors, delivery, quota gate, pause gate, or dispatch cap; `pending[0]` is the lexicographic selection CONTROL-FAIRNESS says to correct | `control-plane/application/advance-once.ts`; `dispatch-policy.ts` and `quota-policy.ts` uncalled; `maxDispatches` parsed and unused; `ResidentHost` default sleep resolves only on abort | 25A steps 6, 8 |
| 11 | Empty `ActivityRegistry` means no real Wake root can boot | `composition-root.ts:57`; `compileWorkflow` resolves stage `activity:` names against it | 25A step 5, §7.3 |
| 12 | Two competing runner-selection designs | `RunnerRegistry` tier lookup versus `createAgentActivity(runner)` binding one at construction; `createExecutionService` takes no runner, workspace, or transcript port | A1 |
| 13 | No target counterpart at all: workspace cleanup on close (`core/workspace-cleanup.ts`, EXEC-WORKSPACE `preserve`), transcript retention (OPS-TRANSCRIPT `preserve`), artifact verification (`github-artifact-verifier.ts`, ACT-REVIEW `correct`), custom-command parsing (`domain/custom-commands.ts`), branch naming (`domain/branch-naming.ts`) | — | 25B |
| 14 | Built but unreachable from any production composition | `recovery-service`, `run-liveness-service`, `active-run-cancellation`, `work-cancellation-policy`, `control-plane-service`, `signal-reactor`, `watch-reactor`, `delivery-service`, `delivery-outcome-reactor`, `inbound-translator`, `poll-service`, `git-workspace`, `transcripts`, `retry-policy`, `supplemental-policy` | 25A steps 6, 8 |

### A.4 Weaknesses in the corrective design review

1. **C1 overstates the absence of hosts** — see A.2.
2. **The §3.4 locality check cannot catch gap 1.** A path-scoped grep is blind to
   GitHub semantics minted _into_ domain values. Addressed in §8.
3. **§4 is organized by config section**, so config discovery (gap 8) and
   `workflowSelectors` (gap 3) fall through it entirely.
4. **§5's "reuses / extends" column understates the work.** `golden-path`,
   `configured-workflow`, `blocked-reply`, `pr-*`, `retry-boundary`,
   `child-loop-guard`, `recover-active-run`, `journal-restart` and `outbox-crash`
   all run on `test-next/e2e/support/world.ts`, not the composition root. Only
   `api-domain-shape` and `configured-workflow` call `createCompositionRoot`, and
   none goes through `src-next/main.ts` from an on-disk root. These are new
   process-level scenarios that borrow assertions, not reusable runs.
5. **§5 has no scenario that would have caught gap 2.** It must require that the
   delivered effect target the resource identity intake created in the same run,
   and that at least one intent be a non-PR publication.
6. **RC-4 is narrower than CONTROL-QUOTA**, which also requires reported reset
   times, bounded fallback backoff, alternate eligible runner selection, and
   operator unpause. None exist.
7. **Decision 3 has no gate.** `github/infrastructure/delivery.ts` already
   converts any thrown error into `Failed` and returns `Unknown` from
   `reconcile()` unconditionally, so a timeout on a merge is indistinguishable
   from a rejection — the assumption EXEC-RECOVERY and INT-OUTBOX forbid.
8. **RC-1 remains outstanding.** The corrective design §3.1 vocabulary
   (`replicate now` / `adjust` / `ignore`) still fails `check:catalogue`. Resolved
   by decision: use the existing catalogue vocabulary only.

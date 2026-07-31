# Wake Live Runtime Parity Correction Design

## 1. Purpose

This corrective design establishes how Wake's target architecture will regain
the agreed operational capabilities of the legacy runtime without reintroducing
legacy coupling or treating existing target modules as proof of a working
product.

The immediate trigger is that the target contains independently tested GitHub,
runner, delivery, configuration, and surface modules, but its production
composition root does not assemble them into a configured live process. The
current target can exercise an in-memory deterministic workflow; it cannot yet
prove the end-to-end operational loop that Wake operators rely on. It also
must not make GitHub's labels, comments, message format, or command syntax an
implicit part of Wake's domain model.

The correction is a mandatory work packet between Task 25 and Task 26 of
`2026-07-30-wake-target-architecture-rewrite.md`. It must pass before any
cutover or claim of target operational equivalence.

## 2. Outcome

With an approved target configuration, a target Wake process can:

1. load configuration and durable state from a Wake root;
2. observe configured external-work evidence through provider-owned adapters;
3. translate provider evidence into canonical commands and facts;
4. create and progress eligible WorkItems according to approved policy;
5. select and invoke configured agent runners in an approved workspace;
6. persist transcripts, recover active Runs, and obey cancellation/lease rules;
7. deliver approved external effects through the durable delivery journal and
   provider-owned publication behavior;
8. expose the resulting public views through the target CLI, API, and web UI.

This outcome does not require literal preservation of legacy implementation,
configuration names, routes, or storage. It requires explicit decisions and
direct evidence for every legacy operator-visible capability in scope.

## 3. Governing decisions

### 3.1 Existing architecture remains the default authority

The target architecture design and its module boundaries remain authoritative.
The correction does not import legacy `src/**` implementations into
`src-next/**`, restore a global `WakeConfig`, or let surfaces reach adapters or
persistence directly.

The functional-decision catalogue remains the ledger for legacy capability
decisions. Every reviewed item must have exactly one disposition:

- **replicate now**: preserve the observable capability using target-native
  contracts;
- **adjust**: preserve the operator outcome while deliberately changing policy,
  configuration, or presentation;
- **defer**: omit it from this correction with a reason, owner, and future
  trigger;
- **ignore**: remove it because it is obsolete, unsafe, or contradicted by the
  approved target design.

No implicit omission, undocumented configuration loss, or "covered by a
module" assertion is acceptable.

### 3.2 Architecture may be amended when evidence demands it

For each legacy capability selected for replication or adjustment, review its
target design fit against these invariants:

- domain modules own policy and canonical facts;
- integrations only observe/translate provider evidence and deliver approved
  external intents;
- the journal is canonical truth; projections and checkpoints are rebuildable;
- activities receive narrow ports, not provider clients or global state;
- bootstrap is the only production composition location;
- CLI/API/web use public application views and commands only;
- failures and ambiguous effects remain explicit and recoverable.

If the target design cannot support an agreed capability without violating an
invariant, write and approve a dated design amendment before implementation.
Do not work around the conflict inside bootstrap or an adapter.

### 3.3 Providers own their interaction semantics

Wake distinguishes external-work providers from source-control/pull-request
providers. GitHub implements both roles in this correction. Future ticket
providers may include Jira, Linear, and Notion; future source-control/PR
providers may include GitLab. Their addition must not require a domain or
workflow rewrite.

The shared target boundary is intentionally narrow. It carries provider
identity, canonical external-resource identity, normalized work/revision facts,
and approved domain publication requests. It does **not** prescribe labels,
comments, slash commands, markdown headers, review APIs, status fields, or any
other GitHub-shaped operation.

Each provider implementation owns all of the following:

- configuration schema and validation for that provider;
- polling/webhook mechanics, pagination, caching, and provider event
  deduplication;
- provider-object normalization and correlation evidence;
- eligibility filtering and provider-native state/status synchronization;
- recognition of output written by Wake and suppression of provider-specific
  feedback loops;
- parsing provider-native human interaction into provider-neutral proposed
  decisions;
- formatting and publication of provider-native status, replies, reviews,
  labels, or other interactions;
- provider-specific idempotency and reconciliation.

The GitHub provider therefore owns `wake:status.*`, `wake:stage.*`, and
`wake:workflow.*` labels, GitHub comment headers/body formatting, and GitHub
slash-command conventions. No domain, orchestration, execution, activity,
surface, or shared integration component may inspect, generate, or configure
those details.

Task 25A delivers GitHub as the only real provider. It also delivers a
non-GitHub fake-provider contract test whose interaction model has no labels
or slash commands, proving that the shared seam does not rely on GitHub
semantics. It does not deliver a real Jira, Linear, Notion, or GitLab adapter.

### 3.4 GitHub locality rule

GitHub is not a built-in domain concept. In production code, a case-insensitive
`github` identifier, string literal, import path, type, configuration property,
event name, adapter ID, or test fixture is permitted only under
`src-next/integrations/github/**` or `test-next/integrations/github/**`.
Documentation and the GitHub provider's own package metadata are not subject to
that source-code rule.

All shared Integration contracts use provider-neutral names and values. They
must not expose `GitHubAdapterId`, `BuiltInAdapterId.GitHub`, a top-level
`integrations.github` field, `integration.github.*` event names, or a
GitHub-specific export from a general Integration barrel. Provider discovery
and registration must use a generic provider-plugin contract so Bootstrap and
the shared Integration layer do not name a concrete provider.

Tests outside the GitHub namespace must use provider-neutral fake identities.
The default names are `fakeTicketing` for external-work interactions and
`fakeSourceControl` or `fakePr` for pull-request/source-control interactions.
They must not use GitHub-shaped keys, labels, comments, commands, or event
names merely because GitHub is the first real adapter.

This rule is deliberate testable architecture, not a naming preference. The
corrective packet adds a static boundary check that fails on a GitHub reference
outside the permitted paths. It also renames existing generic fixtures and
test data before using them as provider-neutral evidence.

## 4. Evidence-led review

The correction begins with a full, traceable review of the legacy live runtime.
The review must analyse source, tests, configuration schema/defaults, current
operator documentation, and controlled execution where useful.

The initial target audit has already found GitHub leakage outside the GitHub
namespace: built-in integration identifiers/configuration, general integration
exports, a fake external source, and generic architecture, activity, resource,
bootstrap, surface, and E2E fixtures/tests. The corrective inventory records
each occurrence, its target-neutral replacement, and the boundary test that
proves its removal.

The inventory must cover at least:

- configuration discovery, merge order, defaults, validation, and every
  operator-supported setting;
- GitHub authentication, repository discovery, issue/PR/review/comment
  observation, pagination, ETags, polling cadence, eligibility policy, and
  deduplication; the same review identifies the target provider-neutral facts
  and the GitHub-only behavior that must remain enclosed;
- work creation/correlation, durable workflow-selection policy, state movement,
  and the reconciliation of provider labels that mirror Wake status, workflow,
  and stage without replacing unrelated user labels;
- human command interpretation, identity/permission policy, recognition of
  Wake-authored comments, and bot/self-reply suppression;
- Claude, Codex, Cursor, and fake runner selection, commands, models,
  timeouts, new-session/resume semantics, headless structured output, prompt
  frontmatter, template rendering context, workspaces, transcripts, retries,
  cancellation, and recovery;
- sentinel/result-envelope parsing, structured agent-reported decisions and
  artefacts, outcome policy such as approval gates, and durable Run recording;
- status/reply/approval/merge delivery, including operator-facing run metadata,
  agent messages, next-step instructions, idempotency, ambiguity
  reconciliation, and provider-side error handling;
- child workflow/watch behavior, review/revision policy, and loop guards;
- closed-workspace cleanup and transcript retention;
- tick, resident, schedules, CLI commands, API/UI host lifecycle, sandbox, and
  operational diagnostics.

Each inventory row names its legacy evidence paths, target design section,
target implementation status, proposed disposition, configuration mapping,
tests, and a manual verification reference if one is needed.

## 5. Target configuration agreement

Target configuration is domain-shaped rather than backward compatible by
accident. The review must produce an approved mapping from every supported
legacy setting to one of:

- a target module-owned configuration field;
- a target-native replacement with documented behavioral change;
- an explicit defer/ignore decision.

Bootstrap may aggregate validated module subtrees in
`ResolvedWakeModulesConfig`, but no domain or adapter constructor may accept
that aggregate. Runner-specific settings belong to Execution; provider
credentials, repositories, observation policy, message formats, and
provider-native interaction rules belong to that provider's configuration
subtree under Integrations;
workflow policy belongs to Orchestration/Activities; host settings belong to
Control Plane and Surfaces.

`docs/configuration.md` remains legacy documentation until the agreed target
configuration is implemented and documented. It must not be used as evidence
that the target accepts a setting.

## 6. Corrected runtime composition

Bootstrap will be the sole assembly point for production dependencies. From
validated configuration it will construct and connect:

- target filesystem journal, projections, checkpoints, locks, transcripts, and
  workspaces;
- registered built-in Activities, including agent and PR activities, each with
  its narrow ports;
- configured runner instances and a tier-aware registry;
- a provider registry composed from configured provider subtrees; in this
  packet it registers GitHub only;
- the GitHub client plus GitHub-owned issue, pull-request, review, and comment
  observation and publication components;
- provider-neutral polling/discovery dispatch, inbound decision application,
  domain reactors, and their durable checkpoints;
- the journal-backed external delivery service and a provider-selected delivery
  adapter/reconciliation path;
- cancellation, liveness, recovery, schedule, tick, and resident hosts;
- CLI/API/web applications over the same public application services.

The host lifecycle must provide a deterministic ordering and bounded work per
tick. Repeated polling and process restart must not duplicate a WorkItem, Run,
or external effect. The delivery and inbound checkpoints must survive restart
and be rebuildable from journal truth where the target architecture requires.

## 7. Proof strategy

### 7.1 Automated proof

Automated tests are the primary continuous evidence.

- Unit tests prove adapter translation, policy, configuration validation, and
  error/ambiguity behavior.
- Composition tests prove only validated module subtrees reach their owners and
  that production bootstrap creates each configured service.
- A process-level fake E2E starts the target entrypoint from on-disk
  configuration; it observes fake GitHub evidence, creates/progresses work,
  executes a fake runner, records durable state, and confirms a fake outbound
  effect.
- A provider-boundary contract test runs the same shared intake and publication
  path with a fake non-GitHub provider whose state synchronization and human
  interaction use provider-specific fields rather than labels or slash
  commands.
- Restart, duplicate, cancellation, failed delivery, and reconciliation
  scenarios exercise the same composed runtime rather than isolated helper
  objects.

### 7.2 Manual real-GitHub acceptance checks

Manual checks validate the provider boundary where a local fake cannot fully
prove behavior. They use a disposable GitHub repository and a documented,
repeatable script. Credentials must come from the approved local configuration
or environment mechanism and must never be committed or printed.

The script will cover the final agreed capability set. At minimum, if those
capabilities are classified `replicate now`, it proves issue intake and update,
workflow selection and GitHub-label synchronization, one agent workflow, a
GitHub human review/comment decision, and one intended GitHub effect.
Each observation is recorded with command, configuration fixture shape,
expected public view, and result. A failed manual check returns work to the
owning corrective task; it is not waived by a passing fake.

## 8. Delivery sequence and gate

The companion implementation plan will be ordered as:

1. inventory and controlled legacy evidence capture;
2. target-design and configuration decisions, including any approved amendment;
3. failing whole-runtime composition tests;
4. target-native implementation by integration/execution/delivery boundary;
5. process-level fake E2E and recovery proof;
6. manual disposable-GitHub acceptance script and execution;
7. documentation and catalogue audit.

The main rewrite plan will receive **Task 25A: Restore and prove live runtime
capability** immediately after Task 25. Task 26 and all later tasks are blocked
until Task 25A records:

- approved dispositions for every reviewed legacy capability;
- target-design alignment or an approved amendment for every adjustment;
- passing automated composition and process-level fake E2E evidence;
- completed manual acceptance evidence for every `replicate now` real-provider
  capability;
- accurate target configuration and operator documentation.

## 9. Out of scope

This correction does not require pixel-level legacy UI parity, migration
compatibility for legacy HTTP endpoints, acceptance of legacy configuration
syntax, or an external production deployment. Those remain separate decisions.
It does require that any such omission be explicit in the catalogue rather than
an accidental consequence of incomplete wiring.

GitHub is the only real provider delivered by this correction. The review must
identify the extension requirements for Jira, Linear, Notion, GitLab, and other
providers, but must not imply that an arbitrary real provider adapter is
`replicate now`. The fake non-GitHub contract provider is required proof of the
seam, not a production integration.

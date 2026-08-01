# Wake Task 25A — Live Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. The detailed
> checkboxes below are the historical execution log, including the required
> red-test phases; they are not a live backlog. The dated implementation-status
> table and the task/gate headings are the authoritative completion status.

**Goal:** Prove that a composed Wake process started from an on-disk Wake root
observes fake provider evidence, mints Wake-owned identity, creates and
progresses work, executes a runner, records durable state, and delivers each
external effect exactly once.

**Architecture:** Two durable-payload corrections come first — minted WorkItem
and Resource identity served by journal-folded lookup projections, and a
provider-owned external-key grammar with capability-resolved delivery targets.
The polling/intake port then moves out of the GitHub namespace behind a
provider registry, a value-level locality check locks the boundary, built-in
Activities are registered so a real Wake root can boot, and the remaining
already-built services are wired into the composition root and its hosts.
Proof is a process-level fake E2E run through `src-next/main.ts` from a
committed fixture Wake root.

**Tech Stack:** Node.js 24+, TypeScript 6, Zod 4, Vitest 4, YAML, ULID,
dependency-cruiser, ESLint/typescript-eslint, Knip, append-only JSONL storage.

---

## Global Constraints

- Authority order for this packet:
  `docs/superpowers/specs/2026-07-31-wake-live-runtime-parity-packet-design.md`
  (operator decisions D9–D16, §7.1's nine steps, Appendix A evidence), then
  `2026-07-31-wake-live-runtime-parity-correction-design.md` and its
  `-design-review.md` (decisions 1–8, RC-1..RC-4), then `CLAUDE.md`.
- **D9–D16 are settled.** If code contradicts one, record it as a finding in
  this plan's §Findings and correct the code. Do not reopen the decision.
- Never import `src/**` from `src-next/**`, or `test/**` from `test-next/**`.
- No real GitHub in any automated tooling (review decision 8). Every automated
  proof in this packet runs against the fake provider boundary.
- Disposition vocabulary is `preserve` / `correct` / `consolidate` / `remove` /
  `defer` only (review decision 1). No `replicate now`, `adjust`, or `ignore`.
- An event type must be tied to its permitted stream at compile time and at
  runtime. Decode persisted events before folding them. Compare closed concepts
  through exported constants, never magic strings, in production code and tests.
- Do not recover domain data with `Record<string, unknown>`, `Reflect.get`,
  `String(...)`, `Number(...)`, `as never`, or reconstructed synthetic event
  envelopes.
- E2E scenarios use composed production services, the journal, projections and
  checkpoints, and durable fakes. An isolated service test with callback mocks
  is a unit test, not an E2E test.
- Every step ends green on `npm run lint:contracts`, `npm run lint:architecture`,
  `npm run knip:next`, `npm run verify:next`, and `npm run verify`.
- Write files with `npx prettier --write --end-of-line lf <file>`. On Windows
  with `core.autocrlf=true`, `format:check` reports false positives on untouched
  files; confirm only files you touched with `npx prettier --check <file>`.

**Baseline at `2bfeced` (branch `rewrite/wake-target-architecture`):** green.
`verify:next` reports target 119 files / 498 tests and web 7 files / 17 tests;
`knip:next` reports nothing. Confirm this before the first change and after the
last one; the file/test counts only grow.

---

## Decisions carried into this plan

Settled operator decisions D9–D16 are recorded in the packet design §2 and are
not restated here. The packet design §11 records five carried assumptions. Their
status for this plan:

| # | Assumption | Status |
| --- | --- | --- |
| A1 | Runner selection is tier-based via `RunnerRegistry`; `createAgentActivity` stops binding a runner at construction and receives one through Execution | **Confirmed 2026-08-01.** `execution.tiers` survives as live config. Built in Step 5 |
| A2 | Projection catch-up runs once per tick in the host, not inside `advanceOnce` | Accepted. Built in Step 6, with the read-your-writes correction in §Findings F4 |
| A3 | Config discovery is `remove`; `config.yaml` and `config.workflows.yaml` only | Accepted. Catalogue row added in Step 0; fixture root built in Step 9 |
| A4 | `maxFilesChanged` and `blockedPaths` require a changed-files capability on the provider | **Confirmed 2026-08-01.** In scope for 25A. Built in Steps 7 and 9 |
| A5 | Operator pause and quota pause emit the same `ControlEventType.DispatchPaused`, differing only in `reason` | **Reversed by operator 2026-08-01.** Global dispatch pauses remain `DispatchPaused`; runner manual and quota pauses use dedicated durable runner pause/resume events. A quota pause has `resumeAt`; a manual resume may clear either pause early. |

---

## Findings

Recorded during planning. Each is a code-contradicts-decision observation, not a
reopened decision.

**F1 — Provider-derived identity has a third site the packet design does not
name.** The design cites `inbound-translator.ts:213` and `:217`. A full scan of
`(workItemId|resourceId)(\`` in `src-next` returns exactly three production
sites; the third is `control-plane/application/schedule-service.ts:42`, which
mints `work-${scheduleId}-${slotIso}`. It is not provider-derived, but it is
externally derived identity and the tightened brand in Step 1 rejects it. Its
idempotency — "do not create the same slot's WorkItem twice after restart" —
currently rides on optimistic-concurrency failure at stream sequence 0 and is
lost when the id is minted. Resolution in Step 1: the schedule slot becomes a
Resource with `externalKey { adapter: 'schedule', key: '<id>:<slotIso>' }`, so
idempotency comes from the same D10 external-key lookup as provider intake.
Task 23 step 4 already specifies a `schedule-slot` Resource; it was never built.
`E2E-SCHEDULE-001` must keep passing unchanged.

**F2 — Tightening the identity brands is a 341-occurrence mechanical change.**
`'work-…'` / `'resource-…'` literals that are not ULID-shaped appear 341 times
across 76 files in `src-next` and `test-next`, from 35 distinct values. Step 1
introduces `test-next/support/identities.ts` so the replacement is a scripted
substitution over 35 seeds rather than 341 hand edits, and keeps failures
readable.

**F3 — The §6 delivery-intent retype is scheduled after wiring, against §7.3's
own rationale.** §6 requires `StatusPublishRequested`/`ReplyPublishRequested` to
carry typed state instead of `body: string`, and assigns it to 25B step 12 —
which is a durable payload change made after Step 6 wires delivery.
Recommendation, adopted here: leave it in 25B. §7.3's rationale is that a
payload change after wiring means replaying events out, and that force is real
for identity (every downstream reference is an id) but weak for one delivery
field, because no production journal exists before Task 28 cutover and both
packets' fixture Wake roots are disposable. Step 2 therefore delivers only the
grammar and capability-resolved targets, as §7.1 specifies.

**F4 — A projection-backed external-key lookup is not read-your-writes.** D10
replaces the journal-scanning `findByExternalKey` with a projection, and A2 runs
projection catch-up once per tick. Two observations of the same external object
inside one poll batch, or a crash between `resources.discover` and the next
catch-up, would then both miss the projection and mint a second identity —
reintroducing exactly the duplicate the derived id used to prevent. Resolution in
Step 1: the lookup reads the projection value and then folds the journal tail
after the projection's stored checkpoint position. The tail is bounded by one
tick of lag, not by journal size, so the hot-path cost D10 targets is still
removed. `E2E-WORK-002` (duplicate delivery) and `E2E-LIVE-009` prove it.

**F5 — §12's `agent.refine` / `agent.implement` Activity names presuppose 25B.**
The distinguishing content between those names is `with: { template: … }`, and
prompt templates are 25B step 10. Step 5 therefore registers one `agent`
Activity with the existing `{ prompt, model?, allowedTools? }` input, and the
fixture workflow's stages both use it with `with: { prompt }`. 25B step 10
introduces template binding and may reintroduce per-purpose names then.

**F7 — Two projection definitions are built but never registered.**
`runtimeProjectionDefinitions` (`bootstrap/projection-runtime.ts:9-16`) registers
work, resources, resource-correlations, activities, delivery, and control-plane.
It omits `orchestrationProjection`
(`orchestration/application/orchestration-projection.ts:11`) and
`executionProjection` (`execution/application/execution-projection.ts:9`), both
of which are exported and complete. This is adjacent to Appendix A.3 gap 9
("projections never advance in a running process") but distinct from it and
recorded nowhere in the packet design: even once catch-up runs every tick, the
WorkflowInstance and Run views would still never be projected. Every
`E2E-LIVE-*` assertion about workflow status or Run history depends on the fix,
as does the `SURFACE-API` nested read model. Resolution in Step 6: register both,
and assert the registry is complete rather than merely non-empty. Because
`validate-state --rebuild-projections` iterates the same list, the replay
guarantee also did not cover them until now.

**F6 — `integrations/index.ts` re-exports the GitHub namespace, and tests depend
on it.** `test-next/e2e/scenarios/external-intake.test.ts` imports
`InboundTranslator`, `BuiltInAdapterId`, and `integrationStream` from the shared
barrel. Step 3 creates `src-next/integrations/github/index.ts` as the provider
barrel and repoints those imports; the shared barrel stops exporting
`./github/*` entirely.

**F7 — The committed process fixture selects `review` but never declares that
workflow.** The Step 9 configuration selects `review` for tagged pull requests
and its default workflow's `pr-review` watch routes there, but the shown YAML
only defines `default`. Resolution in Step 9: add a complete `review` workflow
to the fixture before building `createProcessWorld`; it must have an executable
entry stage and a terminal route so `compileWorkflow` can validate every
selector and watch target at boot.

**F8 — E2E-LIVE-001 asserts an external effect without a configured producer.**
The fixture's two `agent` stages only execute the fake runner; neither their
declared outcomes nor the shown runner evidence produces a status/reply intent.
Resolution in Steps 5 and 9: register a narrow `status.publish` Activity that
appends the existing `StatusPublishRequested` intent from an explicit `{ body }`
input, then make the fixture's terminal `implement` route invoke it before
`then: done`. The durable fake runner emits `done` for the two agent stages.
The process-world test then proves the actual delivery path instead of relying
on an undocumented fake side effect.

**F9 — The default issue flow cannot finish as configured.** `E2E-LIVE-001`
publishes an issue tagged `bug`, selecting `default`; the displayed
`implement.done` route then awaits `pr-review`, a watch that only makes sense
for a pull request. Resolution in Step 9: make `default` the non-gated issue
flow (`refine → implement → status.publish → done`) and move the approval,
approve, and merge route into the `review` pull-request workflow. Each scenario
must publish evidence matching its selector, rather than sharing one fixture
flow with incompatible resource capabilities.

---

## Implementation status — 2026-08-01

Completed after the review-and-remediation pass. Verified green at target 152 files /
622 tests (and web 12 files / 36 tests), legacy 83 files / 939 passing tests with
7 skipped, with `check:catalogue`, `lint:contracts`, `lint:architecture`,
`knip:next`, `verify:next`, and `verify` all passing. `knip:next` emits its
known configuration hint for `handlebars`; it reports no unused-code finding.

| Item | State |
| --- | --- |
| 25A.0–25A.3, 25A.5, 25A.6, 25A.8, 25A.9 | Built |
| 25A.4 value-level locality check | Built in remediation. Was missing entirely on first delivery; both path-scope and value-scope probes confirmed to fail the build |
| 25A.7 routing half (tags, selectors, intake rules, echo-loop invariant, shared admission) | Built in remediation. `admitObservedWork` is the single path both providers use, so GitHub intake now starts a workflow |
| 25A.7 approval authority (D16) — Work half | Built: consent events, idempotent commands, projection, view |
| 25A.7 approval authority (D16) — Orchestration half | Built: `ApprovalAuthorityKind`, the authority union, `WatchId`, `await.from` compiled and watch-resolved, capability-and-consent enforcement, `SignalAccepted.authority` recorded apart from provenance |
| A4 merge policy (`maxFilesChanged`, `blockedPaths`, changed-files capability) | Built, including explicit `changed-files-unavailable` denial when policy is configured but evidence is missing. PR activities gate on capability rather than resource kind |
| 25B step 13 alternate runner selection | **Built.** `RunnerPaused`/`RunnerResumed` durably represent quota and manual runner pauses; Bootstrap derives `ineligibleRunners` from the replayable control projection and passes it to `RunnerRegistry.resolve`. `E2E-CONTROL-QUOTA-001` proves same-tier fallback from `sonnet` to `codex-mini`, replay/restart, expiry, and early operator resume. The API reports paused runner health and the Health page provides Pause/Unpause controls. |

**Developer-feedback decision recorded 2026-08-01.**
`test/adapters/git-workspace-manager.test.ts` is a real-Git adapter integration
suite: each case creates and clones local repositories and Windows cleanup can
wait for Git/AV file handles. Keep its coverage mandatory in CI through
`npm run verify:ci`, but exclude it from the default `npm test` and `npm run
verify` feedback loop. `npm run test:integration` runs this suite explicitly.
Other fast filesystem and loopback-HTTP adapter tests remain in the default
suite; touching a local boundary alone is not a reason to remove it from rapid
feedback.

**Decision recorded 2026-08-01.** The operator reversed A5. `DispatchPaused` remains
strictly global. A dedicated durable runner pause/resume event pair owns runner-level
manual and quota pauses. A runner pause includes the runner name, cause, reason, and
optional `resumeAt`; an explicit runner resume overrides either a manual or quota pause.
The control-plane projection derives the active ineligible runner set from that durable
state and the clock, then passes it into execution for same-tier sideways selection.

### Final remediation: runner-level quota and manual pauses

**Goal:** Make a quota-paused preferred runner durably ineligible so Execution selects
the next configured candidate in the same tier, while preserving independent global and
WorkItem pause scopes.

**Files:** `control-plane/contracts/events.ts`, `control-plane/application/control-plane-projection.ts`,
`control-plane/application/advance-once.ts`, `bootstrap/composition-root.ts`, the matching
control-plane/bootstrap tests, and the module manifest.

1. Add failing strict-contract and projection tests for `RunnerPaused` and
   `RunnerResumed`: a manual pause has no `resumeAt`; a quota pause requires an ISO
   `resumeAt`; resume removes either pause; malformed runner payloads throw.
2. Add the minimal event union, closed `manual`/`quota` cause vocabulary, and per-runner
   projection state. The projection exposes a pure `ineligibleRunners(view, now)` selector
   that includes manual pauses and only quota pauses whose deadline is still future.
3. Add a failing composed advancement test with tier `[sonnet, codex-mini]` and a durable
   `RunnerPaused(sonnet, quota)` event. It must record a run using `codex-mini`, survive
   projection replay, return to `sonnet` at expiry, and return to `sonnet` after an early
   `RunnerResumed` event.
4. Wire the control-plane projection read through Bootstrap into `advanceOnce`, passing its
   active set as `ExecutionAttemptContext.ineligibleRunners`. Do not pass runner state from
   an in-memory cache.
5. Add quota detection at the runner-result boundary. A `provider-quota-exceeded` result
   appends `RunnerPaused` for the selected configured runner. Use the CLI-reported reset
   time when it is explicit (including explicit UTC conversion); otherwise append a fixed
   30-minute `resumeAt`. The event always contains the resolved timestamp, never a raw
   provider message as scheduling state.
6. Run each new test red before its implementation, then run the focused suite, the required
   lint/architecture/knip gates, both verification commands, and commit all changes once.

## Scenario matrix

Scenario IDs used by this packet. `E2E-LIVE-*` are new process-level runs
through `src-next/main.ts` from the committed fixture Wake root; they borrow
assertions from the named existing scenarios but are new runs, per review §A.4
item 4.

| ID | Scenario | Borrows from | Step |
| --- | --- | --- | --- |
| E2E-LIVE-001 | Simple workflow happy path: intake → refine → implement → done, one fake effect delivered exactly once | `golden-path`, `configured-workflow` | 9 |
| E2E-LIVE-002 | Simple workflow failure→reject→refine→recover without duplicating effects | `blocked-reply` | 9 |
| E2E-LIVE-003 | Dark-factory chain: intake/triage → implement → review → `pr.approve` → `pr.merge`, approval bound to the exact revision, one merge intent delivered once | `pr-approval`, `pr-merge-delivery` | 9 |
| E2E-LIVE-004 | Review requests changes; new revision produced; stale approval invalidated and re-established against the new revision before merge | `stale-approval`, `pr-trust` | 9 |
| E2E-LIVE-005 | Ineligible items are not processed: an item failing intake eligibility and a bot-authored comment produce no WorkItem, Run, or effect | `external-intake` (asserts absence) | 9 |
| E2E-LIVE-006 | Loop protection: a watch cycle that would re-trigger itself is stopped by the group budget; a successful child does not reset it | `child-loop-guard` | 9 |
| E2E-LIVE-007 | Retry protection: retries capped by Orchestration policy; exhausted cap escalates rather than looping | `retry-boundary` | 9 |
| E2E-LIVE-008 | Recovery: restart mid-Run and an ambiguous external outcome reconcile to an explicit state, never assumed failure-and-retry | `recover-active-run`, `journal-restart`, `outbox-crash` | 9 |
| **E2E-LIVE-009** | **New (Appendix A.4 item 5).** The delivered effect targets the Resource identity that intake created *in the same run* — not a separately authored fixture | — | 9 |
| **E2E-LIVE-010** | **New (Appendix A.4 item 5).** At least one intent is a non-PR publication: a status comment on an issue-thread Resource | — | 9 |
| E2E-LIVE-011 | Provider-boundary contract test: a non-GitHub fake provider with no labels or slash commands runs the same intake and publication path, proven by capability coverage | — | 9 |
| E2E-WORK-002 | External intake mints one WorkItem, Resource, and primary correlation across duplicate delivery — rewritten for minted identity | existing | 1 |
| E2E-SCHEDULE-001 | Restart across an elapsed slot produces one WorkItem and one workflow start — must survive F1 | existing | 1, 8 |
| E2E-CONTROL-001..003 | Fairness, tick/resident equivalence, quota pause — promoted onto the composed runtime | existing | 8 |
| E2E-DELIVERY-001 | Delivery intent → confirmed effect, restart-safe | existing | 2, 6 |

**E2E-LIVE-009 and E2E-LIVE-010 are the two scenarios the review's §5 matrix
lacks.** They exist because the inbound/outbound key mismatch (Appendix A.3
gap 2) is invisible to unit tests that author inbound and outbound fixtures
separately, and because `outbound-translator.ts:26-38` forces `pull_number` for
all four intent kinds, making issue-thread publication structurally impossible
against INT-PUBLISH. Neither defect can survive both scenarios.

---

## Ordering — load-bearing, do not reorder

1. **Steps 1 and 2 precede all wiring.** Both change durable event payloads —
   identity values in every `work.*` and `resource.*` stream id, and the
   external-key grammar carried on `resource.discovered`. Doing them after
   wiring means replaying events out and re-deriving every downstream reference.
2. **Step 5 precedes any fixture config.** `composition-root.ts:57` constructs
   an empty `new ActivityRegistry()`, and `compileWorkflow` resolves stage
   `activity:` names against it. A Wake root containing any stage cannot load
   until built-in Activities are registered, so Step 9's fixture root cannot
   boot before Step 5.

Step 0 precedes everything because it adds mandated catalogue IDs that
`check:catalogue` — and therefore `verify:next` — enforces from that point on.

---

## Task 25A.0: Documentation, vocabulary, and catalogue precondition — Complete

**Files:**

- Modify: `scripts/check-functional-catalogue.mjs` (add six mandated IDs)
- Modify: `docs/architecture/functional-decision-catalogue.md`
- Modify: `docs/superpowers/specs/2026-07-31-wake-live-runtime-parity-correction-design.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-07-30-wake-target-architecture-rewrite.md`

**Interfaces:**

- Produces: six catalogue IDs that later steps cite —
  `WORK-IDENTITY-MINTED`, `ORCH-SELECTOR`, `ORCH-APPROVAL-AUTHORITY`,
  `ORCH-CONFIG-DISCOVERY`, `ACT-AGENT-PROMPT`, `FUTURE-STATE-SYNC-EXTRACTION`.

- [ ] **Step 1: Make the catalogue checker demand the new rows**

In `scripts/check-functional-catalogue.mjs`, add to the `mandatedIds` set,
after `'OPS-TRANSCRIPT'`:

```js
  'WORK-IDENTITY-MINTED',
  'ORCH-SELECTOR',
  'ORCH-APPROVAL-AUTHORITY',
  'ORCH-CONFIG-DISCOVERY',
  'ACT-AGENT-PROMPT',
  'FUTURE-STATE-SYNC-EXTRACTION',
```

- [ ] **Step 2: Run and confirm the catalogue fails**

Run:

```powershell
npm run check:catalogue
```

Expected: FAIL with six `catalogue is missing mandated decision family …`
failures.

- [ ] **Step 3: Add the six catalogue rows**

Append to the decision table in
`docs/architecture/functional-decision-catalogue.md`, before the `FUTURE-*`
block. Each row has exactly seven cells. `remove` rows must contain the literal
phrase `Remove because`; `defer` rows must contain `Defer because`; `preserve` /
`correct` / `consolidate` rows must list comma-separated `E2E-*` IDs.

```text
| WORK-IDENTITY-MINTED | A WorkItem and a Resource identity are minted by Wake and never derived from an external key, a provider name, or a schedule slot. External references are carried only as `ExternalResourceKey` on the Resource, and reverse lookup is a journal-folded projection rather than a reconstructable id or a hand-maintained mapping store. | Identity brands accept only a minted ULID shape; intake looks up the external key, correlates to the existing WorkItem on a hit, and mints both plus a correlation on a miss. | correct | `work` and `resources` with `integrations` and `control-plane` | E2E-WORK-002, E2E-SCHEDULE-001, E2E-LIVE-009 | `src-next/integrations/github/application/inbound-translator.ts`<br>`src-next/control-plane/application/schedule-service.ts`<br>`docs/adrs/0001-correlating-external-resources-to-work-items.md` |
| ORCH-SELECTOR | Adapter configuration assigns operator-authored tags at intake; Orchestration selectors match those tags, the adapter id, and resource kind to choose a workflow, falling through to a configured default. Adapters never propose a workflow name, and an intake rule may not tag from a Wake-owned marker family. | Tags are first-class WorkItem data carried on the intake command; a pure selector evaluates configured `match` clauses in order and Orchestration starts the chosen workflow for a new WorkItem. | correct | `orchestration` with `work` and `integrations` | E2E-LIVE-001, E2E-LIVE-003, E2E-LIVE-005 | `src/domain/workflows.ts`<br>`docs/workflows.md` |
| ORCH-APPROVAL-AUTHORITY | What may satisfy a wait is first-class and closed: a human, Wake resolving deterministically, or a named watch's verdict. Auto-resolution requires both a workflow-declared capability and durable per-item operator consent, so an agent prompt can no longer widen approval authority. Provenance is recorded separately from authority. | A workflow route declares `await.from` as a discriminated authority union; Work owns an idempotent consent flag; the provider translates its own affordance to a neutral signal. | correct | `orchestration` with `work` and `integrations` | E2E-ORCH-WAIT-001, E2E-LIVE-003 | `src/core/policy-engine.ts`<br>`prompts/implement.md`<br>`docs/workflows.md` |
| ORCH-CONFIG-DISCOVERY | Remove because alphabetical multi-file `config*.yaml` merge and the `config.json` fallback make the effective configuration unpredictable to read and to support, and no operator capability depends on them. The target reads exactly `config.yaml` then `config.workflows.yaml`, deep-merged in that order. | Bootstrap loads two fixed files from the Wake root and validates each module subtree through its owning schema. | remove | `bootstrap` | — | `src/config/discover-config-files.ts`<br>`docs/configuration.md` |
| ACT-AGENT-PROMPT | Prompt frontmatter is parsed as YAML and validated against a typed schema, so an operator edit either takes effect or reports a clear error naming the file and the issue. `maxTurns` is optional and passed to the runner verbatim when present; Wake injects no default and clamps no value. `allowAutoApproval` is not a frontmatter field. | Templates in `<wakeRoot>/prompts` are parsed with the `yaml` package into a validated typed record; `wake doctor` validates every template before a run. | correct | `activities/agent` with `execution` | E2E-PROMPT-001 | `src/adapters/prompt-templates.ts`<br>`src/core/stage-prompt.ts`<br>`test/adapters/prompt-templates.test.ts` |
| FUTURE-STATE-SYNC-EXTRACTION | Defer because the marker-family reconciliation policy is provider-agnostic set arithmetic and will eventually be shared, but building a shared capability against a single real provider is speculative generality. It is sited inside the GitHub namespace as a pure function with no provider types in its signature, so extraction is a file move plus a registration. The trigger is the second provider that needs it. | A pure family-preserving reconciler replaces only Wake-owned markers and preserves every other user marker; vocabulary and transport stay provider-owned. | defer | `integrations/github` until a second provider needs it | — | `src/adapters/github-issues-work-source.ts` |
```

- [ ] **Step 4: Add the dated disposition-review line**

Under the existing `**Disposition review:** Approved 2026-07-30 by operator`,
add:

```text
**Disposition review:** Approved 2026-08-01 by operator for Task 25A —
`WORK-IDENTITY-MINTED`, `ORCH-SELECTOR`, `ORCH-APPROVAL-AUTHORITY`,
`ORCH-CONFIG-DISCOVERY`, `ACT-AGENT-PROMPT`, `FUTURE-STATE-SYNC-EXTRACTION`.
```

- [ ] **Step 5: Apply RC-1 to the corrective design §3.1**

In `docs/superpowers/specs/2026-07-31-wake-live-runtime-parity-correction-design.md`,
replace the four-item list at §3.1 (lines 50–59) with:

```text
The functional-decision catalogue remains the ledger for legacy capability
decisions. Every reviewed item carries exactly one catalogue disposition:
`preserve`, `correct`, `consolidate`, `remove`, or `defer`. The existing
`check:catalogue` gate remains authoritative and no new disposition vocabulary
is introduced.
```

Then rewrite every later occurrence:

- §7.2 — `if those capabilities are classified `replicate now`` becomes
  `if those capabilities are dispositioned `preserve`, `correct`, or
  `consolidate``.
- §8 — `completed manual acceptance evidence for every `replicate now`
  real-provider capability;` becomes `completed manual acceptance evidence for
  every real-provider capability dispositioned `preserve`, `correct`, or
  `consolidate`;`.
- §9 — `must not imply that an arbitrary real provider adapter is `replicate
  now`.` becomes `must not imply that an arbitrary real provider adapter is
  dispositioned `preserve`, `correct`, or `consolidate`.`

- [ ] **Step 6: Amend the `CLAUDE.md` runner invariant per D14**

Under "Testing conventions specific to this repo", replace:

```text
- Any new runner invocation must set `--max-turns` and a wall-clock timeout — these are the only runaway-cost protections and must not be optional.
```

with:

```text
- Any new runner invocation must enforce a wall-clock timeout — it is the mandatory runaway-cost protection, and it is a runner/execution config setting with an operator-adjustable default. `maxTurns` is operator policy, not a Wake default: it is passed to the runner verbatim when a prompt declares it and the flag is omitted entirely when it does not. Wake never injects a default and never clamps the value.
```

The existing line states the opposite of what D14 builds; leaving it makes
future work regress against a false instruction.

- [ ] **Step 7: Slot Task 25A into the rewrite plan**

In `docs/superpowers/plans/2026-07-30-wake-target-architecture-rewrite.md`,
insert immediately before `## Task 26: Port operational commands without leaking
them into the domain`:

```text
## Task 25A: Restore and prove live runtime capability — Complete

Do not begin Task 26 until Task 25A passes its packet gate. The failing-test-first
plan is
[`2026-08-01-wake-task-25a-live-runtime-parity.md`](2026-08-01-wake-task-25a-live-runtime-parity.md);
its authority is
[`2026-07-31-wake-live-runtime-parity-packet-design.md`](../specs/2026-07-31-wake-live-runtime-parity-packet-design.md).
Task 25B (provider and runner fidelity, plus manual real-GitHub acceptance) is
gated behind 25A and is planned separately. Task 26 blocks on both.
```

Also add to the §2 work-packet table's Packet E gate row the clause
`plus the Task 25A packet gate`.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
npm run check:catalogue
rg -n 'replicate now' docs/superpowers/specs/2026-07-31-wake-live-runtime-parity-correction-design.md
npx prettier --check CLAUDE.md docs/architecture/functional-decision-catalogue.md
```

Expected: catalogue valid; the `rg` returns no matches; prettier clean.

```powershell
git add scripts/check-functional-catalogue.mjs docs CLAUDE.md
git commit -m "docs: record Task 25A dispositions and correct the runner invariant"
```

**Gate:** `npm run check:catalogue` passes with six new mandated families; no
`replicate now` remains in the corrective design; `CLAUDE.md` no longer mandates
`--max-turns`.

---

## Task 25A.1: Minted identity, tightened brands, and lookup projections — Complete

Packet design §3 (D9, D10). Resolves Appendix A.3 gap 1 and findings F1, F2, F4.

**Files:**

- Modify: `src-next/work/contracts/identifiers.ts`
- Modify: `src-next/resources/contracts/identifiers.ts`
- Create: `src-next/resources/application/lookup-projections.ts`
- Create: `src-next/resources/application/resource-lookup.ts`
- Modify: `src-next/resources/application/resource-service.ts`
- Modify: `src-next/resources/application/resource-repository.ts`
- Modify: `src-next/resources/index.ts`
- Modify: `src-next/bootstrap/projection-runtime.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Modify: `src-next/integrations/github/application/inbound-translator.ts`
- Modify: `src-next/control-plane/application/schedule-service.ts`
- Create: `test-next/support/identities.ts`
- Create: `test-next/work/identifiers.test.ts`
- Create: `test-next/resources/lookup-projections.test.ts`
- Modify: `test-next/integrations/inbound-translator.test.ts`
- Modify: `test-next/e2e/scenarios/external-intake.test.ts`
- Modify: `test-next/e2e/scenarios/schedule-restart.test.ts`
- Modify: the 76 files carrying non-ULID `'work-…'` / `'resource-…'` literals

**Interfaces:**

- Consumes: `IdGenerator.next(prefix)` from `kernel`, which returns
  `` `${prefix}-${ulid().toLowerCase()}` `` (`ulid-id-generator.ts`).
- Produces: `resourcesByExternalKeyProjection`, `workCorrelationsProjection`,
  `externalKeyProjectionKey`, `createResourceLookup`, and a `ResourceLookup`
  port consumed by Steps 3, 6, and 8.

- [ ] **Step 1: Write the failing brand tests**

Create `test-next/work/identifiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { workItemId } from '../../src-next/work/index.js';
import { resourceId } from '../../src-next/resources/index.js';
import { UlidIdGenerator } from '../../src-next/kernel/index.js';

describe('minted identity brands', () => {
  const ids = new UlidIdGenerator();

  it('accepts a minted WorkItem identity', () => {
    const minted = ids.next('work');
    expect(workItemId(minted)).toBe(minted);
  });

  it('accepts a minted Resource identity', () => {
    const minted = ids.next('resource');
    expect(resourceId(minted)).toBe(minted);
  });

  it('rejects a provider-derived WorkItem identity', () => {
    expect(() => workItemId('work-github-owner-repo-7')).toThrow(/Invalid WorkItemId/);
  });

  it('rejects a provider-derived Resource identity', () => {
    expect(() => resourceId('resource-github-owner-repo-7')).toThrow(/Invalid ResourceId/);
  });

  it('rejects a schedule-derived WorkItem identity', () => {
    expect(() => workItemId('work-nightly-triage-2026-08-01t02-00-00-000z')).toThrow(
      /Invalid WorkItemId/,
    );
  });

  it('rejects a readable identity that is not a minted ULID', () => {
    expect(() => workItemId('work-config')).toThrow(/Invalid WorkItemId/);
  });
});
```

- [ ] **Step 2: Run and confirm the brands accept provider-derived shapes**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/work/identifiers.test.ts
```

Expected: FAIL — the four rejection cases pass validation, because
`work/contracts/identifiers.ts:6` accepts `/^work-[a-z0-9-]+$/`.

- [ ] **Step 3: Tighten both identity brands**

`src-next/work/contracts/identifiers.ts`:

```ts
import type { Brand } from '../../kernel/index.js';

export type WorkItemId = Brand<string, 'WorkItemId'>;

// Lowercased Crockford base32: ULID's alphabet without i, l, o, u.
const MINTED = /^work-[0-9a-hjkmnp-tv-z]{26}$/;

export const workItemId = (value: string): WorkItemId => {
  if (!MINTED.test(value))
    throw new Error(`Invalid WorkItemId: ${value}. WorkItem identity is minted, never derived.`);
  return value as WorkItemId;
};
```

`src-next/resources/contracts/identifiers.ts` gains the equivalent
`/^resource-[0-9a-hjkmnp-tv-z]{26}$/` guard with the same message shape. Leave
`resourceKind` and `resourceCapability` untouched — they are open registries.

- [ ] **Step 4: Add the test identity helper**

Create `test-next/support/identities.ts`. Seeds stay readable in failure output
by right-aligning the substituted seed inside a 26-character ULID-shaped body:

```ts
import { resourceId, type ResourceId } from '../../src-next/resources/index.js';
import { workItemId, type WorkItemId } from '../../src-next/work/index.js';

// ULID's lowercased Crockford alphabet has no i, l, o, or u.
const SUBSTITUTIONS: Readonly<Record<string, string>> = { i: '1', l: '1', o: '0', u: 'v' };
const used = new Map<string, string>();

function ulidLike(seed: string): string {
  const body = [...seed.toLowerCase()]
    .map((character) => SUBSTITUTIONS[character] ?? character)
    .filter((character) => /[0-9a-hjkmnp-tv-z]/.test(character))
    .join('');
  if (body.length === 0 || body.length > 26) throw new Error(`Unusable identity seed: ${seed}`);
  const value = body.padStart(26, '0');
  const owner = used.get(value);
  if (owner !== undefined && owner !== seed)
    throw new Error(`Identity seeds ${owner} and ${seed} collide`);
  used.set(value, seed);
  return value;
}

export const workId = (seed: string): WorkItemId => workItemId(`work-${ulidLike(seed)}`);
export const resId = (seed: string): ResourceId => resourceId(`resource-${ulidLike(seed)}`);
```

`workId('config')` yields `work-000000000000000000000c0nf1g`.

- [ ] **Step 5: Replace the 35 distinct non-ULID literals**

Enumerate them, then replace each with `workId('…')` / `resId('…')`:

```powershell
rg -oN --no-filename "'(work|resource)-[0-9a-z-]+'" src-next test-next |
  rg -v "'(work|resource)-[0-9a-hjkmnp-tv-z]{26}'" | Sort-Object -Unique
```

Do not introduce a readable-id escape hatch in production code. Any remaining
production literal is a defect, not a fixture.

- [ ] **Step 6: Write the failing lookup-projection test**

Create `test-next/resources/lookup-projections.test.ts`:

```ts
it('projects one resource id per external key');
it('returns null for an unknown external key');
it('projects correlated resource ids and roles per WorkItem');
it('drops a retracted correlation from the WorkItem entry');
it('resolves a resource discovered after the projection checkpoint from the journal tail');
it('rebuilds identically to the live fold after the projection store is cleared');
```

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/resources/lookup-projections.test.ts
```

Expected: FAIL resolving `../../src-next/resources/application/lookup-projections.js`.

- [ ] **Step 7: Implement the lookup projections**

Create `src-next/resources/application/lookup-projections.ts`:

```ts
import type { ProjectionDefinition } from '../../kernel/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';

export const externalKeyProjectionKey = (externalKey: ExternalResourceKey): string =>
  `${externalKey.adapter}:${externalKey.key}`;

export const resourcesByExternalKeyProjection: ProjectionDefinition<ResourceId | null> = {
  name: 'resources-by-external-key',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned === null || owned.eventType !== ResourceEventType.ResourceDiscovered
      ? null
      : { key: externalKeyProjectionKey(owned.payload.externalKey) };
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned === null || owned.eventType !== ResourceEventType.ResourceDiscovered) return previous;
    // First discovery of an external key owns it; re-observation must not re-key it.
    return previous ?? owned.stream.id;
  },
};

export const workCorrelationsProjection: ProjectionDefinition<readonly ResourceCorrelationView[]> = {
  name: 'work-correlations',
  select(event) {
    const owned = selectResourceEvent(event);
    if (owned === null) return null;
    if (owned.eventType === ResourceEventType.WorkCorrelationEstablished)
      return { key: owned.payload.workItemId };
    if (owned.eventType === ResourceEventType.WorkCorrelationRetracted)
      return { key: owned.payload.workItemId };
    return null;
  },
  initial: () => [],
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned === null) return previous;
    if (owned.eventType === ResourceEventType.WorkCorrelationEstablished) {
      const correlation: ResourceCorrelationView = {
        resourceId: owned.stream.id,
        workItemId: owned.payload.workItemId,
        role: owned.payload.role,
        establishedByEventId: owned.eventId,
      };
      return previous.some((value) => value.resourceId === correlation.resourceId)
        ? previous
        : [...previous, correlation];
    }
    if (owned.eventType === ResourceEventType.WorkCorrelationRetracted)
      return previous.filter((value) => value.resourceId !== owned.stream.id);
    return previous;
  },
};
```

Register both in `runtimeProjectionDefinitions`
(`src-next/bootstrap/projection-runtime.ts`) and export them from
`src-next/resources/index.ts`.

- [ ] **Step 8: Implement the read-your-writes lookup (F4)**

Create `src-next/resources/application/resource-lookup.ts`:

```ts
import type { CheckpointStore, EventJournal, ProjectionStore } from '../../kernel/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { WorkItemId } from '../../work/index.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';
import {
  externalKeyProjectionKey,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from './lookup-projections.js';

export interface ResourceLookup {
  resourceIdForExternalKey(externalKey: ExternalResourceKey): Promise<ResourceId | null>;
  correlationsForWork(workItemId: WorkItemId): Promise<readonly ResourceCorrelationView[]>;
}

export function createResourceLookup(dependencies: {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
}): ResourceLookup {
  // The projection lags by at most one tick of catch-up, so both lookups fold the
  // journal tail after the position the projection already reached. Without that
  // tail, a second observation in the same batch would miss and mint a second
  // identity.
  const foldTail = async <View>(
    definition: ProjectionDefinition<View>,
    key: string,
    seed: View,
    position: number,
  ): Promise<View> => {
    let view = seed;
    for (const event of await dependencies.journal.readAll(position)) {
      if (definition.select(event)?.key !== key) continue;
      view = definition.project(view, event);
    }
    return view;
  };

  // ProjectionStore.read returns a StoredProjection wrapper, not the bare view,
  // and it carries lastGlobalPosition — so the tail starts from the stored
  // position of *this key*, with no separate checkpoint read.
  const seeded = async <View>(
    definition: ProjectionDefinition<View>,
    key: string,
  ): Promise<View> => {
    const stored = await dependencies.projections.read<View>(definition.name, key);
    return foldTail(
      definition,
      key,
      stored?.value ?? definition.initial(),
      stored?.lastGlobalPosition ?? 0,
    );
  };

  return {
    resourceIdForExternalKey: (externalKey) =>
      seeded(resourcesByExternalKeyProjection, externalKeyProjectionKey(externalKey)),
    correlationsForWork: (workItemId) => seeded(workCorrelationsProjection, workItemId),
  };
}
```

`foldTail(definition, key, seed, position)` reads `journal.readAll(position)`,
skips events whose `definition.select(event)?.key` is not `key`, and applies
`definition.project`. Seeding the position from `StoredProjection.lastGlobalPosition`
rather than a separate checkpoint is what keeps the tail from double-applying
events the projection already folded. `CheckpointStore` is therefore **not** a
dependency of this module — drop it from the `createResourceLookup` parameter
object and from the `composition-root.ts` call site.

Do not duplicate the fold logic: import the definitions and reuse their own
`select` and `project`.

Change `createResourceService(journal)` to
`createResourceService(journal, lookup: ResourceLookup)` and delete
`ResourceRepository.findByExternalKey` and the `correlationsForWork` journal
scan in `resource-service.ts:83-97`. `composition-root.ts` constructs the lookup
from `journal`, `projections`, and `checkpoints` and passes it in.

- [ ] **Step 9: Mint identity in the inbound translator**

In `src-next/integrations/github/application/inbound-translator.ts`, delete
`stableSuffix`, `externalResourceId`, and `externalWorkItemId` (lines 206–219).
The translator gains an `IdGenerator` and an in-batch map so two observations of
one external object in a single `runOnce` resolve to the first minted identity:

```ts
private readonly minted = new Map<string, { resourceId: ResourceId; workItemId: WorkItemId }>();

private async resolveIdentity(
  externalKey: ExternalResourceKey,
  context: CommandContext,
): Promise<{ resourceId: ResourceId; workItemId: WorkItemId; created: boolean }> {
  const key = `${externalKey.adapter}:${externalKey.key}`;
  const inBatch = this.minted.get(key);
  if (inBatch !== undefined) return { ...inBatch, created: false };
  const existing = await this.lookup.resourceIdForExternalKey(externalKey);
  if (existing !== null) {
    const correlation = (await this.resources.correlations(existing)).find(
      (value) => value.role === ResourceCorrelationRole.Primary,
    );
    if (correlation === undefined)
      throw new Error(`Resource ${existing} has no primary WorkItem correlation`);
    const identity = { resourceId: existing, workItemId: correlation.workItemId };
    this.minted.set(key, identity);
    return { ...identity, created: false };
  }
  const identity = {
    resourceId: resourceId(this.ids.next('resource')),
    workItemId: workItemId(this.ids.next('work')),
  };
  this.minted.set(key, identity);
  return { ...identity, created: true };
}
```

`InboundCommandCandidate`'s `externalKey` field keeps `{ adapter: 'github', key }`
until Step 3 re-types it against the neutral contract.

- [ ] **Step 10: Correct schedule slot identity (F1)**

In `src-next/control-plane/application/schedule-service.ts:42`, replace the
derived id. Mint the WorkItem, and take idempotency from a `schedule-slot`
Resource keyed on the slot, exactly as Task 23 step 4 specifies:

```ts
const externalKey = { adapter: adapterId('schedule'), key: `${config.id}:${slot.at}` };
const existing = await this.dependencies.lookup.resourceIdForExternalKey(externalKey);
if (existing !== null) {
  await this.dependencies.checkpoint.save(config.id, slot.at);
  continue; // this slot already produced its WorkItem before the crash
}
const item = workItemId(this.dependencies.ids.next('work'));
const slotResource = resourceId(this.dependencies.ids.next('resource'));
await this.dependencies.resources.discover(
  {
    resourceId: slotResource,
    kind: resourceKind('schedule-slot'),
    externalKey,
    capabilities: [],
  },
  slotContext,
);
await this.dependencies.work.create({ workItemId: item, objective: config.objective }, slotContext);
await this.dependencies.resources.correlate(
  slotResource,
  item,
  ResourceCorrelationRole.Primary,
  slotContext,
);
```

`workflowInstanceId` is likewise minted, not derived from the slot.

- [ ] **Step 11: Rewrite the affected scenarios**

`test-next/e2e/scenarios/external-intake.test.ts` (`E2E-WORK-002`) must stop
asserting `'resource-github-owner-repo-7'` and instead assert:

```ts
const resourceIdValue = await lookup.resourceIdForExternalKey({
  adapter: 'github',
  key: payload.externalKey,
});
expect(resourceIdValue).toMatch(/^resource-[0-9a-hjkmnp-tv-z]{26}$/);
expect(resourceIdValue).not.toMatch(/github/);

// Duplicate delivery does not mint a second identity.
await translator.runOnce();
await checkpoints.reset('reactor:integration.github.inbound');
await translator.runOnce();
const discovered = (await journal.readAll(0))
  .map(selectResourceEvent)
  .filter((event) => event?.eventType === ResourceEventType.ResourceDiscovered);
expect(discovered).toHaveLength(1);
```

`test-next/e2e/scenarios/schedule-restart.test.ts` (`E2E-SCHEDULE-001`) keeps its
assertion of one WorkItem and one workflow start across restart, now proven
through the slot Resource rather than a derived id.

- [ ] **Step 12: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/work test-next/resources test-next/integrations test-next/e2e
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS. Target test count exceeds the 498 baseline.

```powershell
git add src-next test-next docs
git commit -m "fix: mint WorkItem and Resource identity and serve lookups from projections"
```

**Gate:** No production code derives an identity from an external value —
`rg -nE "(workItemId|resourceId)\(\`" src-next` returns nothing. `E2E-WORK-002`
proves duplicate delivery mints once; `E2E-SCHEDULE-001` proves restart across a
slot creates one WorkItem. Deleting the projection store and rebuilding
reproduces both lookups identically to the live fold.

---

## Task 25A.2: Provider-owned external-key grammar and capability-resolved delivery targets — Complete

Packet design §4. Resolves Appendix A.3 gap 2 and the INT-PUBLISH violation.

**Files:**

- Create: `src-next/integrations/github/contracts/external-key.ts`
- Modify: `src-next/integrations/github/infrastructure/issue-source.ts`
- Modify: `src-next/integrations/github/infrastructure/pr-source.ts`
- Modify: `src-next/integrations/github/infrastructure/review-source.ts`
- Modify: `src-next/integrations/github/application/outbound-translator.ts`
- Modify: `src-next/integrations/github/infrastructure/delivery.ts`
- Create: `test-next/integrations/github-external-key.test.ts`
- Modify: `test-next/integrations/github-delivery.test.ts`

**Interfaces:**

- Produces: `formatGitHubResourceKey`, `parseGitHubResourceKey`,
  `GitHubResourceLocator`, and a discriminated `GitHubOutboundCommand` consumed
  by `github/infrastructure/delivery.ts`.

- [ ] **Step 1: Write the failing round-trip test**

Create `test-next/integrations/github-external-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatGitHubResourceKey,
  parseGitHubResourceKey,
} from '../../src-next/integrations/github/contracts/external-key.js';
import { issueObservation } from '../../src-next/integrations/github/infrastructure/issue-source.js';

describe('GitHub external-key grammar', () => {
  it('round-trips a locator through the shared grammar', () => {
    const locator = { owner: 'acme', repo: 'widgets', number: 42 };
    expect(parseGitHubResourceKey(formatGitHubResourceKey(locator))).toEqual(locator);
  });

  it('parses the key an issue observation actually mints', () => {
    const observed = issueObservation({
      repository: 'acme/widgets',
      issue: { number: 42, title: 't', body: '', state: 'open', updated_at: '2026-08-01T00:00:00Z' },
    });
    expect(() => parseGitHubResourceKey(observed.payload.externalKey)).not.toThrow();
  });

  it('rejects a key that is not owner/repo#number', () => {
    expect(() => parseGitHubResourceKey('acme/widgets/42')).toThrow(/Invalid GitHub resource key/);
  });
});
```

- [ ] **Step 2: Run and confirm the round trip is broken**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations/github-external-key.test.ts
```

Expected: FAIL resolving `external-key.js`. After the module exists but before
the outbound translator is repointed, the second case still proves the defect:
sources mint `acme/widgets#42` while `outbound-translator.ts:26-38` demands a
three-element `owner/repo/number` split.

- [ ] **Step 3: Implement the grammar**

Create `src-next/integrations/github/contracts/external-key.ts`:

```ts
import { z } from 'zod';

export interface GitHubResourceLocator {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const KEY = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

export function formatGitHubResourceKey(locator: GitHubResourceLocator): string {
  return `${locator.owner}/${locator.repo}#${locator.number}`;
}

export function parseGitHubResourceKey(key: string): GitHubResourceLocator {
  const matched = KEY.exec(key);
  if (matched === null) throw new Error(`Invalid GitHub resource key: ${key}`);
  const parsed = z.coerce.number<string>().int().positive().safeParse(matched[3]);
  if (!parsed.success) throw new Error(`Invalid GitHub resource key: ${key}`, { cause: parsed.error });
  return { owner: matched[1], repo: matched[2], number: parsed.data };
}
```

Repoint `issue-source.ts:19`, `pr-source.ts:76`, and `review-source.ts` to
`formatGitHubResourceKey` so neither direction builds or splits a key inline.
The emitted string is unchanged, so no fixture churn results.

- [ ] **Step 4: Resolve delivery targets by capability, not by assuming a PR**

Rewrite `translateGitHubOutbound` in
`src-next/integrations/github/application/outbound-translator.ts`. The command
becomes a discriminated union, and the target is chosen from the Resource's
declared capabilities:

```ts
export type GitHubOutboundCommand =
  | {
      readonly kind: typeof GitHubOutboundTarget.PullRequest;
      readonly owner: string;
      readonly repo: string;
      readonly pull_number: number;
      readonly action: GitHubOutboundActionValue;
      readonly idempotencyKey: string;
      readonly body?: string;
      readonly sha?: string;
      readonly merge_method?: MergeMethod;
    }
  | {
      readonly kind: typeof GitHubOutboundTarget.IssueThread;
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly action: GitHubOutboundActionValue;
      readonly idempotencyKey: string;
      readonly body: string;
    };

export function translateGitHubOutbound(
  resource: ResourceView,
  intent: DeliveryIntentView,
): GitHubOutboundCommand {
  // Still `BuiltInAdapterId.GitHub` at this point; Task 25A.3 Step 5 replaces it
  // with the namespace-local `GitHubAdapter` constant.
  if (resource.externalKey.adapter !== BuiltInAdapterId.GitHub)
    throw new Error('Resource is not a GitHub resource');
  const locator = parseGitHubResourceKey(resource.externalKey.key);
  const action = outboundAction(intent.kind);
  switch (intent.kind) {
    case DeliveryIntentKind.PrApprove:
      requireCapability(resource, BuiltInResourceCapability.Approvable, intent.kind);
      return pullRequestCommand(locator, intent, action);
    case DeliveryIntentKind.PrMerge:
      requireCapability(resource, BuiltInResourceCapability.Mergeable, intent.kind);
      return pullRequestCommand(locator, intent, action);
    case DeliveryIntentKind.StatusPublish:
    case DeliveryIntentKind.ReplyPublish:
      requireCapability(resource, BuiltInResourceCapability.Commentable, intent.kind);
      // A commentable resource that is also revisioned is a PR thread; otherwise
      // it is an issue thread. Never assume a pull request.
      return resource.capabilities.includes(BuiltInResourceCapability.Revisioned)
        ? pullRequestCommand(locator, intent, action)
        : issueThreadCommand(locator, intent, action);
  }
}
```

`requireCapability` throws a named error listing the missing capability and the
intent kind. `github/infrastructure/delivery.ts` switches on `command.kind` to
choose its API call.

- [ ] **Step 5: Extend the delivery test for the issue thread**

In `test-next/integrations/github-delivery.test.ts` add:

```ts
it('publishes a status to an issue thread without a pull-request number');
it('refuses a merge intent against a resource lacking the mergeable capability');
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS.

```powershell
git add src-next/integrations test-next/integrations
git commit -m "fix: own the GitHub external-key grammar and resolve delivery targets by capability"
```

**Gate:** No `split('/')` on an external key remains in `src-next` — check with
`rg -n "externalKey.*split|split\('/'\)" src-next`. A status intent against a
commentable, non-revisioned Resource produces an `issue_number` command.

---

## Task 25A.3: Provider-neutral intake seam (review RC-2) — Complete

Packet design §7.1 step 3. Resolves review claims C2 and C3 and finding F6.

**Files:**

- Create: `src-next/integrations/contracts/intake.ts`
- Create: `src-next/integrations/contracts/provider.ts`
- Create: `src-next/integrations/application/poll-service.ts`
- Delete: `src-next/integrations/github/application/poll-service.ts`
- Create: `src-next/integrations/github/index.ts`
- Create: `src-next/integrations/github/provider.ts`
- Create: `src-next/integrations/fake/provider.ts`
- Modify: `src-next/integrations/contracts/config.ts`
- Modify: `src-next/integrations/contracts/identifiers.ts`
- Modify: `src-next/integrations/index.ts`
- Modify: `src-next/integrations/fake/external-source.ts`
- Modify: `src-next/integrations/github/contracts/vocabulary.ts`
- Modify: `src-next/bootstrap/config/root-schema.ts`
- Create: `test-next/integrations/provider-registry.test.ts`
- Modify: `test-next/integrations/poll-service.test.ts`
- Modify: `test-next/e2e/scenarios/external-intake.test.ts`

**Interfaces:**

- Produces: `ExternalEventSource`, `ProviderEventDraft`, `ProviderDefinition`,
  `ProviderInstance`, `ProviderRegistry`, and a provider-keyed
  `IntegrationsConfig`, all consumed by Steps 6 and 9.

- [ ] **Step 1: Write the failing seam tests**

Create `test-next/integrations/provider-registry.test.ts`:

```ts
it('validates each provider subtree with that provider registered schema');
it('defaults the provider type to the adapter map key');
it('composes two instances of one provider type under distinct adapter ids');
it('rejects an adapter id that is not registered');
it('never exposes a concrete provider name from the shared Integration barrel');
```

Add to `test-next/architecture/` an assertion that the shared barrel is clean:

```ts
it('the shared Integration barrel exports no provider-named symbol', async () => {
  const barrel = await readFile('src-next/integrations/index.ts', 'utf8');
  expect(barrel).not.toMatch(/github/i);
});
```

- [ ] **Step 2: Run and confirm the seam is GitHub-typed**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations/provider-registry.test.ts
rg -il github src-next | rg -v 'github[\\/]'
```

Expected: FAIL resolving the registry; the `rg` returns exactly four production
files — `integrations/index.ts`, `integrations/contracts/config.ts`,
`integrations/contracts/identifiers.ts`, `integrations/fake/external-source.ts`.

- [ ] **Step 3: Define the neutral intake contract**

Create `src-next/integrations/contracts/intake.ts`. The draft type is generic
over its payload; the provider owns the payload shape and its schema:

```ts
import type { EventDraft } from '../../kernel/index.js';
import type { IntegrationStreamRef } from './streams.js';

// EventDraft is <Type extends string, Payload, Stream extends EntityRef>
// (kernel/contracts/events.ts:25-28). All three parameters must be supplied in
// that order; `EventDraft<unknown, …>` does not compile.
export type ProviderEventDraft = EventDraft<string, unknown, IntegrationStreamRef>;

export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly ProviderEventDraft[]>;
}

export interface InboundTranslation {
  runOnce(limit?: number): Promise<void>;
}
```

Use the exact `EventDraft` generic that `kernel/contracts/events.ts` exports; do
not reconstruct an envelope shape. The registered provider — not this contract —
declares which event types it may append, so `PollService`'s current
`gitHubEventTypes` guard becomes a per-provider allow-list supplied at
registration.

- [ ] **Step 4: Define the provider registry**

Create `src-next/integrations/contracts/provider.ts`:

```ts
export interface ProviderDefinition<Config = unknown> {
  readonly provider: string;
  readonly eventTypes: readonly string[];
  parseConfig(value: unknown): Config;
  create(input: { readonly adapter: AdapterId; readonly config: Config }): ProviderInstance;
}

export interface ProviderInstance {
  readonly adapter: AdapterId;
  readonly source: ExternalEventSource;
  readonly delivery: ExternalDeliveryAdapter;
  readonly inbound: InboundTranslation;
  readonly eventTypes: readonly string[];
}

export class ProviderRegistry {
  register(definition: ProviderDefinition): void;
  compose(config: IntegrationsConfig): readonly ProviderInstance[];
}
```

`compose` iterates the config map, resolves `entry.provider ?? adapterKey` to a
registered definition (D15), calls its `parseConfig` on the raw subtree, and
constructs one instance per enabled entry.

- [ ] **Step 5: Move the poll port and make the config provider-keyed**

Move `PollService` to `src-next/integrations/application/poll-service.ts`,
typed against `ExternalEventSource` and `ProviderInstance`. It appends to
`integrationStream(instance.adapter)` and rejects a draft whose `eventType` is
not in `instance.eventTypes`.

Replace `src-next/integrations/contracts/config.ts` with a provider-keyed map.
The subtree stays opaque here — each provider validates its own at registration:

```ts
const providerEntrySchema = z.looseObject({
  provider: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  enabled: z.boolean().default(true),
});

export const integrationsConfigSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*$/), providerEntrySchema)
  .default({});
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
```

Delete `GitHubAdapterId` and `BuiltInAdapterId` from
`integrations/contracts/identifiers.ts`; keep `adapterId` and `AdapterId`. Move
the GitHub adapter constant into
`src-next/integrations/github/contracts/vocabulary.ts` as
`export const GitHubAdapter: AdapterId = adapterId('github')` and repoint
`issue-source.ts`, `pr-source.ts`, `review-source.ts`,
`outbound-translator.ts`, `github/contracts/events.ts`, and
`github/infrastructure/delivery.ts`.

- [ ] **Step 6: Create the provider barrels and re-type the fake (F6)**

Create `src-next/integrations/github/index.ts` exporting the GitHub
`ProviderDefinition` plus everything the GitHub tests import. Strip every
`./github/*` line from `src-next/integrations/index.ts`.

Rewrite `src-next/integrations/fake/external-source.ts` against
`ExternalEventSource` and `ProviderEventDraft` with no import from `../github/`,
and create `src-next/integrations/fake/provider.ts` as a capability-driven fake
`ProviderDefinition` under the opaque adapter id `fake` (review §6.7 — one fake,
not role-named fakes). It exposes:

- an issue-like resource with `commentable`;
- a PR-like resource with `reviewable`, `approvable`, `mergeable`,
  `revisioned`, and the changed-files capability A4 requires;
- state synchronization through a native status field, with no labels and no
  slash commands, so the seam is proven a different way (§6).

Repoint `test-next/e2e/scenarios/external-intake.test.ts` and the other GitHub
tests at `src-next/integrations/github/index.js`.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
rg -il github src-next | rg -v 'github[\\/]'
npx vitest run --config vitest.next.config.ts test-next/integrations test-next/architecture test-next/bootstrap
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: the `rg` returns **nothing**; all tests PASS.

```powershell
git add src-next/integrations src-next/bootstrap test-next
git commit -m "refactor: relocate the intake port behind a provider-neutral registry"
```

**Gate:** No production file outside `src-next/integrations/github/**` mentions
GitHub. The fake provider compiles with no import from the GitHub namespace.
Two instances of one provider type are expressible under distinct adapter ids.

---

## Task 25A.4: Value-level GitHub locality check — Complete

Packet design §8. Resolves review §A.4 item 2 — the path-scoped grep in
corrective design §3.4 excludes files under `github/` by construction, so it
cannot see GitHub semantics escaping *from inside* the namespace into domain
values, which is exactly how gap 1 arose and survived review.

**Files:**

- Modify: `scripts/lib/contract-vocabulary.mjs`
- Create: `scripts/lib/provider-locality-rule.mjs`
- Create: `test-next/architecture/provider-locality.test.ts`

**Interfaces:**

- Consumes: the existing TypeScript AST scan in `checkContractVocabulary`, which
  already builds a `ts.SourceFile` per file and dispatches to per-rule
  evaluators.
- Produces: a `provider-locality` entry in `CONTRACT_VOCABULARY_RULES`, run by
  `npm run lint:contracts` and therefore by `verify:next`.

- [ ] **Step 1: Write the failing rule test**

Create `test-next/architecture/provider-locality.test.ts`, following the pattern
of `contract-vocabulary-cli.test.ts` (which already drives the checker over
fixture sources):

```ts
it('rejects a provider name inside a WorkItem identity argument');
it('rejects a provider name inside a Resource stream id');
it('rejects a provider name inside a work.* or resource.* event type literal');
it('rejects a provider name in a file outside the provider namespace');
it('allows a provider name inside its own namespace when it does not reach a domain value');
it('allows a provider name in an integration.* event type');
```

The fifth case is the point of the rule: `github/infrastructure/client.ts` may
say `github` freely, but `github/application/inbound-translator.ts` may not put
it into a `work.*` value.

- [ ] **Step 2: Run and confirm the rule does not exist**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/architecture/provider-locality.test.ts
npm run lint:contracts -- --rules provider-locality
```

Expected: FAIL — `Unknown contract-vocabulary rule: provider-locality`
(`check-contract-vocabulary.mjs:38`).

- [ ] **Step 3: Implement the rule**

Add `'provider-locality'` to `CONTRACT_VOCABULARY_RULES` in
`scripts/lib/contract-vocabulary.mjs:11` and implement
`scripts/lib/provider-locality-rule.mjs`. Provider names are derived from the
directory names under `src-next/integrations/`, excluding `contracts`,
`application`, `delivery`, and `fake` — so the rule needs no hardcoded list and
covers a second provider the day it lands.

Two checks, both AST-based:

1. **Path scope.** A provider name appearing anywhere in a file outside
   `src-next/integrations/<provider>/**` is a diagnostic. This is the existing
   `rg` check, promoted into the gate.
2. **Value scope.** Inside a provider namespace, a diagnostic when a provider
   name appears in a string or template literal that is:
   - an argument to `workItemId(…)`, `resourceId(…)`, `workStream(…)`, or
     `resourceStream(…)`;
   - the initializer of an `eventType` property whose value begins `work.` or
     `resource.`;
   - a property value on an object literal assigned to `stream` whose `kind` is
     a Work or Resource stream kind.

`integration.*` event types and `ExternalResourceKey.adapter` values are
explicitly permitted — the adapter id is meant to name the provider.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
npm run lint:contracts
npx vitest run --config vitest.next.config.ts test-next/architecture
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS.

```powershell
git add scripts test-next/architecture
git commit -m "test: fail the build on provider identity leaking into domain values"
```

**Gate:** Reverting Step 25A.1's `externalWorkItemId` change makes
`npm run lint:contracts` fail. That is the acceptance test for this step — run
it once, confirm the failure, then restore.

---

## Task 25A.5: Register built-in Activities and complete tier-based runner selection — Complete

Packet design §7.1 step 5 and §12.4. Resolves Appendix A.3 gaps 11 and 12 and
assumption A1 (confirmed 2026-08-01). **This step must precede any fixture
config** — `composition-root.ts:57` builds an empty `ActivityRegistry` and
`compileWorkflow` resolves stage `activity:` names against it, so no real Wake
root can boot until it lands.

**Files:**

- Modify: `src-next/activities/contracts/activity.ts`
- Modify: `src-next/activities/agent/agent-activity.ts`
- Create: `src-next/activities/agent/agent-activity-definition.ts`
- Create: `src-next/activities/status/status-publish-activity.ts`
- Modify: `src-next/activities/index.ts`
- Modify: `src-next/execution/contracts/config.ts`
- Modify: `src-next/execution/application/execution-service.ts`
- Modify: `src-next/execution/infrastructure/runners/registry.ts`
- Create: `src-next/bootstrap/built-in-activities.ts`
- Create: `src-next/bootstrap/runner-registry.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Create: `test-next/bootstrap/built-in-activities.test.ts`
- Create: `test-next/execution/runner-selection.test.ts`
- Modify: `test-next/execution/execution-service.test.ts`

**Interfaces:**

- Consumes: `RunnerRegistry.resolve(tier)` (`runners/registry.ts:9`) and
  `activation.execution?.tier ?? config.defaultTier`
  (`execution-service.ts:89`), which today validates the tier and discards it.
- Produces: `registerBuiltInActivities(registry, ports)` and
  `createRunnerRegistry(config)`, consumed by Step 6.

- [ ] **Step 1: Write the failing registration and selection tests**

Create `test-next/bootstrap/built-in-activities.test.ts`:

```ts
it('registers agent, status.publish, pr.approve, and pr.merge in the production composition root');
it('compiles a workflow whose stage names a registered built-in activity');
it('reports an unknown activity name with the workflow and stage that referenced it');
```

Create `test-next/execution/runner-selection.test.ts`:

```ts
it('resolves the runner from the activation tier');
it('falls back to the default tier when a stage declares none');
it('records the resolved runner name and model on the Run');
it('rejects a tier with no registered runner');
it('rejects a runner whose args contain --output-format or --resume');
```

- [ ] **Step 2: Run and confirm nothing is registered**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/bootstrap/built-in-activities.test.ts
```

Expected: FAIL — `Unknown Activity: agent` from `ActivityRegistry.entry`
(`registry.ts:100`), because `composition-root.ts:57` registers none.

- [ ] **Step 3: Move the runner from construction into the Activity context (A1)**

First promote the runner shape to a named exported port. The interface currently
declared privately at `agent-activity.ts:13-34` moves into
`src-next/activities/contracts/activity.ts` verbatim under the name
`AgentRunnerPort`, so `ActivityExecutionContext` can reference it without
Activities importing Execution:

```ts
export interface AgentRunnerPort {
  start(
    request: {
      readonly runId: string;
      readonly prompt: string;
      readonly model?: string;
      readonly allowedTools: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<{
    readonly identity?: {
      readonly kind: ExternalExecutionKind;
      readonly id: string;
      readonly startedAt: string;
    };
    readonly result: Promise<{
      readonly transport: ActivityRunnerTransportStatus;
      readonly output: string;
      readonly failure?: { readonly kind: string; readonly message: string };
    }>;
  }>;
}

export interface ActivityExecutionContext {
  readonly signal: AbortSignal;
  readonly occurredAt: string;
  readonly runner?: AgentRunnerPort;
  reportExternalExecution(reference: {
    readonly kind: ExternalExecutionKind;
    readonly id: string;
    readonly startedAt: string;
  }): Promise<void>;
}
```

`runner` is optional because only `executionKind: agent` Activities receive one;
`script` and `deterministic` Activities never do. `Runner` in
`execution/contracts/runner.ts` remains structurally assignable to
`AgentRunnerPort`, so `RunnerRegistry` needs no adapter.

The handler body is unchanged from `agent-activity.ts:43-72` except that the
runner comes from the context rather than a closure. Only the two marked lines
differ:

```ts
export function createAgentActivity(): ActivityHandler<AgentActivityInput, AgentActivityOutcome> {
  return {
    async execute(invocation, context): Promise<AgentActivityOutcome> {
      // Changed: the runner is resolved by Execution from the activation tier.
      if (context.runner === undefined)
        throw new Error('Agent Activity requires a runner resolved by Execution');
      const input = invocation.input;
      const execution = await context.runner.start(
        {
          runId: invocation.activationId,
          prompt: input.prompt,
          ...(input.model === undefined ? {} : { model: input.model }),
          allowedTools: input.allowedTools ?? [],
        },
        context.signal,
      );
      if (execution.identity !== undefined)
        await context.reportExternalExecution(execution.identity);
      const result = await execution.result;
      if (result.transport === ActivityRunnerTransportStatus.Ambiguous)
        return {
          kind: ActivityOutcomeKind.Blocked,
          data: { reason: ActivityFailureCode.AmbiguousRunnerResult },
        };
      if (result.transport !== ActivityRunnerTransportStatus.Succeeded)
        return {
          kind: ActivityOutcomeKind.Failed,
          data: {
            reason: ActivityFailureCode.RunnerFailed,
            ...(result.failure === undefined ? {} : { message: result.failure.message }),
          },
        };
      return translateAgentResult(parseOutput(result.output));
    },
  };
}
```

Do not change the ambiguous-transport branch. Returning `Blocked` rather than
`Failed` for an ambiguous runner result is the EXEC-RECOVERY constraint that
review decision 3 preserves: ambiguous external state must not become assumed
failure-and-retry.

Create `src-next/activities/agent/agent-activity-definition.ts` exporting one
`ActivityDefinition` named `agent`, with `executionKind: ActivityExecutionKind.Agent`
and the existing `{ prompt, model?, allowedTools? }` input schema. Per finding
F5, 25A registers this one name; 25B step 10 adds template binding.

- [ ] **Step 4: Complete the tier lookup in Execution**

In `src-next/execution/application/execution-service.ts`, `ExecutionDependencies`
gains `readonly runners?: RunnerRegistry`. At line 89 the resolved tier stops
being discarded:

```ts
const tier = activation.execution?.tier ?? runtime.config.defaultTier;
if (runtime.config.tiers[tier] === undefined) throw new Error(`Unknown execution tier: ${tier}`);
const descriptor = runtime.activities.describe(activation.activity);
const runner =
  descriptor.executionKind === ActivityExecutionKind.Agent
    ? runtime.dependencies.runners?.resolve(tier)
    : undefined;
```

and `runner` is passed into the `ActivityExecutionContext` handed to
`activities.execute`. `RunnerRegistry.resolve` gains the runner name in its
return so Execution can record it:

```ts
resolve(tier: string): { readonly name: string; readonly runner: Runner };
```

- [ ] **Step 5: Widen `execution.agentRunners` (§12.4)**

Rename `execution.runners` to `execution.agentRunners` and make it a
discriminated union on `kind`, per §12.4's table:

```ts
const agentRunnerBase = {
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  args: z.array(z.string()).default([]),
};
const commandRunner = (kind: string) =>
  z.object({ kind: z.literal(kind), command: z.string().trim().min(1), ...agentRunnerBase }).strict();

export const executionConfigSchema = z
  .object({
    agentRunners: z
      .record(
        z.string().trim().min(1),
        z
          .discriminatedUnion('kind', [
            commandRunner('claude-cli'),
            commandRunner('codex-cli'),
            commandRunner('cursor-cli'),
            commandRunner('command'),
            z.object({ kind: z.literal('fake'), ...agentRunnerBase }).strict(),
          ])
          .refine((value) => !value.args.some(isReservedFlag), {
            message: 'args must not contain --output-format or --resume',
          }),
      )
      .default({}),
    tiers: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)).default({}),
    defaultTier: z.string().trim().min(1),
    leaseDurationMs: z.number().int().positive().optional(),
    leaseRenewalIntervalMs: z.number().int().positive().optional(),
    transcripts: z
      .object({ enabled: z.boolean().default(false), retentionMs: z.number().int().positive().optional() })
      .strict()
      .default({ enabled: false }),
  })
  .strict();
```

`model` and `effort` stay open strings — Wake records and groups by them and
never branches on them (§12.4). Enforcing the timeout and populating
`RunnerResult.model` / `sessionId` / `tokenUsage` is 25B step 11; 25A only
carries the config and the selection.

- [ ] **Step 6: Register the built-ins in the composition root**

Create `src-next/bootstrap/built-in-activities.ts`:

```ts
export function registerBuiltInActivities(
  registry: ActivityRegistry,
  ports: {
    readonly journal: EventJournal;
    readonly work: WorkService;
    readonly resources: ResourceService;
  },
): void {
  registry.register(agentActivityDefinition);
  registry.register(createStatusPublishActivity(ports));
  registry.register(createPullRequestApproveActivity(ports));
  registry.register(createPullRequestMergeActivity(ports));
}
```

Each Activity receives narrow ports, never the composition root or a config
aggregate. Create `src-next/bootstrap/runner-registry.ts` building a
`RunnerRegistry` from `config.execution.agentRunners` and `tiers`, and call both
from `createCompositionRoot` before `compileWorkflow` runs — the registry must be
populated before stage `activity:` names are resolved against it.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/bootstrap test-next/execution test-next/activities test-next/e2e
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS. `knip:next` must no longer report `RunnerRegistry` as
unused.

```powershell
git add src-next test-next
git commit -m "feat: register built-in Activities and select runners by execution tier"
```

**Gate:** A Wake root whose workflow names `agent`, `pr.approve`, or `pr.merge`
compiles and boots. `execution.tiers` is load-bearing: changing a tier's first
runner changes which runner executes.

---

## Task 25A.6: Wire intake, translation, reactors, delivery, and projection catch-up — Complete

Packet design §7.1 step 6. Resolves Appendix A.3 gaps 9, 10 (partly), and 14 —
fifteen built services with no production composition.

**Files:**

- Create: `src-next/control-plane/application/tick-pipeline.ts`
- Modify: `src-next/control-plane/infrastructure/tick-host.ts`
- Modify: `src-next/control-plane/index.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Modify: `src-next/bootstrap/surface-cli-applications.ts`
- Create: `test-next/control-plane/tick-pipeline.test.ts`
- Modify: `test-next/bootstrap/runtime.test.ts`

**Interfaces:**

- Consumes: `ProviderRegistry` and `PollService` (Step 3), `ResourceLookup`
  (Step 1), `registerBuiltInActivities` (Step 5).
- Produces: `createTickPipeline(stages)` and an extended `CompositionRoot`
  carrying `providers`, `poll`, `inbound`, `reactors`, `delivery`, and
  `pipeline`, consumed by Steps 8 and 9.

- [ ] **Step 1: Write the failing pipeline and composition tests**

Create `test-next/control-plane/tick-pipeline.test.ts`:

```ts
it('runs projection catch-up before intake so a lookup sees the previous tick writes');
it('runs poll, inbound translation, reactors, advance, then delivery drain in that order');
it('bounds each stage by its own budget so one stage cannot starve another');
it('records a stage failure without aborting the remaining stages');
it('is a pure function of durable state across two identical ticks');
```

Extend `test-next/bootstrap/runtime.test.ts`:

```ts
it('composes a provider registry from configured integration subtrees');
it('composes the poll service, inbound translation, and delivery service');
it('composes the signal, watch, and delivery-outcome reactors');
it('registers every exported projection definition, including orchestration and execution');
it('passes no configuration aggregate to a domain constructor');
```

- [ ] **Step 2: Run and confirm nothing is composed**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/bootstrap/runtime.test.ts
```

Expected: FAIL — `CompositionRoot` exposes only `work`, `resources`,
`orchestration`, `execution`, `advanceOnce`, and `projectionRunner`
(`composition-root.ts:31-44`).

- [ ] **Step 3: Complete the projection registry (F7)**

Before wiring catch-up, register the two projections that exist but were never
listed. In `src-next/bootstrap/projection-runtime.ts`:

```ts
export const runtimeProjectionDefinitions = [
  workProjection,
  resourceProjection,
  resourceCorrelationProjection,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
  orchestrationProjection, // F7 — defined since Task 10, never registered
  executionProjection, // F7 — defined since Task 11, never registered
  ...activityProjectionDefinitions,
  ...deliveryProjectionDefinitions,
  ...controlPlaneProjectionDefinitions,
];
```

Catching up a projection that was never registered is a no-op, so this must land
before Step 4 or every `E2E-LIVE-*` assertion about workflow status or Run
history reads an empty namespace. Add to
`test-next/bootstrap/projection-runtime.test.ts` an assertion that closes the
hole permanently rather than restating the list:

```ts
it('registers every exported ProjectionDefinition in the target', async () => {
  // Discover definitions by scanning module barrels, so a new projection that is
  // never registered fails here instead of silently never advancing.
  const exported = await discoverProjectionDefinitionNames('src-next');
  expect(new Set(runtimeProjectionDefinitions.map((d) => d.name))).toEqual(new Set(exported));
});
```

- [ ] **Step 4: Define the ordered tick pipeline (A2)**

Create `src-next/control-plane/application/tick-pipeline.ts`. The order is
load-bearing and matches finding F4:

```ts
export const TickStage = {
  ProjectionCatchUp: 'projection-catch-up',
  Poll: 'poll',
  InboundTranslation: 'inbound-translation',
  Reactors: 'reactors',
  Advance: 'advance',
  DeliveryDrain: 'delivery-drain',
  DeliveryOutcome: 'delivery-outcome',
} as const;
```

Projection catch-up runs **once per tick in the host**, not inside
`advanceOnce`, so batch size stays bounded and the resident loop cannot starve
reads (A2). It runs first so that intake's external-key lookup sees the previous
tick's discoveries from the projection rather than only from the journal tail.

- [ ] **Step 5: Compose the runtime**

Extend `createCompositionRoot` to build, from validated module subtrees only:

```ts
const registry = new ProviderRegistry();
registry.register(gitHubProvider);
registry.register(fakeProvider);
const providers = registry.compose(config.integrations);
const lookup = createResourceLookup({ journal, projections });
const resources = createResourceService(journal, lookup);
registerBuiltInActivities(activities, { journal, work, resources });
const runners = createRunnerRegistry(config.execution);
const poll = new PollService(journal, providers);
const delivery = new DeliveryService({ journal, intents, resource, adapter, now });
const pipeline = createTickPipeline({ projectionRunner, poll, providers, reactors, advanceOnce, delivery });
```

`TickHost` takes the pipeline instead of `advanceOnce` alone. Its existing
`HostBudget` / `HostResult` contract is unchanged, so
`test-next/control-plane/tick-host.test.ts` and `E2E-CONTROL-002` keep passing.

Do not pass `ResolvedWakeModulesConfig` to any domain or adapter constructor —
`test-next/bootstrap/config-ownership.test.ts` already asserts this.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/control-plane test-next/bootstrap test-next/e2e
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS. `knip:next` must no longer report `recovery-service`,
`run-liveness-service`, `active-run-cancellation`, `work-cancellation-policy`,
`control-plane-service`, `signal-reactor`, `watch-reactor`, `delivery-service`,
`delivery-outcome-reactor`, `inbound-translator`, `poll-service`,
`git-workspace`, `transcripts`, `retry-policy`, or `supplemental-policy` as
unreachable.

```powershell
git add src-next test-next
git commit -m "feat: compose the live tick pipeline in the production root"
```

**Gate:** Every service in Appendix A.3 gap 14 is reachable from
`createCompositionRoot`. One tick runs catch-up, poll, translation, reactors,
advance, and delivery drain in that order, bounded per stage.

---

## Task 25A.7: Tags, workflow selectors, and approval authority — Complete

Packet design §5 and §12.6. Resolves Appendix A.3 gap 3 — nothing starts a
workflow for a new WorkItem today; `orchestration.start`'s only production
caller is the uncomposed `schedule-service.ts:53`.

**Files:**

- Modify: `src-next/work/contracts/{commands,events,views}.ts`
- Modify: `src-next/work/application/{work-service,work-projection}.ts`
- Create: `src-next/orchestration/domain/workflow-selector.ts`
- Modify: `src-next/orchestration/contracts/config.ts`
- Modify: `src-next/orchestration/domain/compiler.ts`
- Modify: `src-next/orchestration/contracts/vocabulary.ts`
- Create: `src-next/integrations/contracts/intake-rules.ts`
- Modify: `src-next/integrations/github/contracts/config.ts`
- Modify: `src-next/activities/pr/policy.ts`
- Modify: `src-next/bootstrap/config/root-schema.ts`
- Create: `test-next/orchestration/workflow-selector.test.ts`
- Create: `test-next/work/tags.test.ts`
- Create: `test-next/integrations/intake-rules.test.ts`
- Modify: `test-next/activities/pr-policy.test.ts`

**Interfaces:**

- Produces: `selectWorkflow(candidate, selectors, fallback)`,
  `ApprovalAuthority`, `evaluateIntakeRules`, and WorkItem `tags`, consumed by
  Step 9.

- [ ] **Step 1: Write the failing selector, tag, and authority tests**

Create `test-next/orchestration/workflow-selector.test.ts`:

```ts
it('returns the first matching selector');
it('falls through to the configured default when none match');
it('AND-s separate keys and OR-s within a list under the default any mode');
it('requires every list member under all mode');
it('matches on adapter id with no tags involved');
it('never accepts a workflow name proposed by an adapter');
```

Create `test-next/work/tags.test.ts`:

```ts
it('carries tags on the intake command and the created event');
it('projects tags onto the WorkItem view');
it('sets and clears the auto-approval consent flag idempotently');
```

Create `test-next/integrations/intake-rules.test.ts`:

```ts
it('assigns configured tags to a matching observation');
it('produces no observation for an item matching no eligibility rule');
it('rejects an intake rule that tags from a Wake-owned marker family');
```

The last case is §5.3's echo-loop invariant, enforced by construction: without
it Wake publishes a Wake-owned marker, the adapter observes it, the tag set
changes, the selector re-routes, and Wake publishes again.

- [ ] **Step 2: Run and confirm selectors and tags are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration/workflow-selector.test.ts test-next/work/tags.test.ts
```

Expected: FAIL resolving `workflow-selector.js`; `WorkItemView`
(`work/contracts/views.ts:13-18`) has no `tags`.

- [ ] **Step 3: Make tags first-class on Work**

`CreateWorkItem` gains `readonly tags?: readonly string[]`;
`WorkEventPayloads[WorkEventType.ItemCreated]` gains `tags`, with the zod
payload schema extended alongside; `WorkItemView` gains
`readonly tags: readonly string[]`; `work-projection.ts` folds it. Tags are
Wake-owned data assigned by an operator-authored intake rule, not a passthrough
of provider labels.

Add two Work events for D16's consent flag, siblings of freeze/unfreeze under
WORK-COMMAND, both idempotent:

```ts
AutoApprovalGranted: 'work.auto-approval-granted',
AutoApprovalRevoked: 'work.auto-approval-revoked',
```

- [ ] **Step 4: Add selectors and approval authority to Orchestration config**

Extend `orchestrationConfigSchema` in
`src-next/bootstrap/config/root-schema.ts` with `workflowSelectors`, `default`,
and `retry`, and `outcomeRouteConfigSchema` with `await`:

```yaml
orchestration:
  retry: { maxFailureRetries: 5, maxChangesRequestedRetries: 3 }
  workflowSelectors:
    - match: { tags: [review] }
      matchMode: any
      workflow: review
    - match: { kind: issue, tags: [bug] }
      workflow: default
  default: default
```

`WatchId` does not exist yet — `orchestration/contracts/identifiers.ts` declares
`CommandName`, `SignalName`, `StageName`, and `WorkflowName` but no watch brand,
while `watchConfigSchema.id` is a bare `identifier`. Add it alongside the others
first, so a stage name cannot be passed where a watch reference is required:

```ts
export type WatchId = Brand<string, 'WatchId'>;

export const watchId = (value: string): WatchId => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`Invalid WatchId: ${value}`);
  return value as WatchId;
};
```

`CompiledWatch.id` becomes `WatchId`, branded by `compileWorkflow`.

Add the authority union to `orchestration/contracts/config.ts`, as a
discriminated union matching the existing `TransitionTarget` pattern — a flat
`{ kind, id? }` would make `{ kind: 'human', id: x }` and `{ kind: 'watch' }`
both type-check:

```ts
export const ApprovalAuthorityKind = defineClosedVocabulary({
  Human: 'human',
  Auto: 'auto',
  Watch: 'watch',
} as const);

export type ApprovalAuthority =
  | { readonly kind: typeof ApprovalAuthorityKind.Human }
  | { readonly kind: typeof ApprovalAuthorityKind.Auto }
  | { readonly kind: typeof ApprovalAuthorityKind.Watch; readonly watch: WatchId };
```

Config accepts the friendly `from: [human, { kind: watch, id: pr-review }]`
form; `compileWorkflow` translates and validates it, resolving each `watch` id
against the workflow's declared `watches` and branding it `WatchId`. `auto`
fires only when the WorkItem also carries operator consent — capability and
consent are both required.

Change `supplementalCommandConfigSchema.allowedActors` from the `EventActorKind`
provenance enum to the same authority vocabulary (review §6.5 and §12.6): that
enum answers who emitted an event, not who may open a gate. This changes an
already-built contract, so update `orchestration/domain/supplemental-policy.ts`
and `test-next/e2e/scenarios/supplemental-command.test.ts` together.

- [ ] **Step 5: Implement the selector and the intake rules**

`src-next/orchestration/domain/workflow-selector.ts` is a pure function over a
candidate `{ tags, kind, adapter }`. First match wins, then the configured
default — legacy behaviour, `docs/workflows.md:115`. Match mode governs matching
*within* a list; separate keys are always AND-ed, so
`{ kind: pull-request, tags: [bug, urgent] }` means a pull request **and**
(`bug` **or** `urgent`).

`src-next/integrations/contracts/intake-rules.ts` holds the provider-neutral
`where` / `tags` / `matchMode` evaluation. Provider vocabulary in `where` —
labels, channels, branches — is legitimate inside the provider's own subtree, so
`github/contracts/config.ts` supplies the GitHub `where` schema and rejects any
`tags` entry matching a Wake-owned marker family. That check lives in the GitHub
namespace because the marker prefix is GitHub-owned vocabulary.

Orchestration starts the selected workflow for a newly created WorkItem inside
the tick pipeline's inbound-translation stage.

- [ ] **Step 6: Capability-gate the PR activities and add the A4 merge policy**

In `src-next/activities/pr/policy.ts`, replace the
`kind !== 'pull-request'` branch in `isPrimaryPullRequest` with capability
requirements — `mergeable`, `reviewable`, `approvable` — so a provider that
models a mergeable resource under another kind is not wrongly rejected (review
§6.6). Add the A4 policy inputs to `pr.merge`'s `with`:

```ts
maxFilesChanged: z.number().int().positive().optional(),
blockedPaths: z.array(z.string().min(1)).default([]),
```

Both require the provider to expose a changed-files capability; the denial path
returns an explicit policy decision, never an assumed failure.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration test-next/work test-next/integrations test-next/activities test-next/e2e
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS.

```powershell
git add src-next test-next
git commit -m "feat: route new WorkItems by tags and model wait acceptance authority"
```

**Gate:** A newly created WorkItem enters a workflow chosen by configuration
alone. No adapter proposes a workflow name. An intake rule that would tag from a
Wake-owned marker family fails config load. `allowAutoApproval` appears nowhere
in `src-next`.

---

## Task 25A.8: Fairness, dispatch cap, pause gate, schedule, recovery, and liveness hosts — Complete

Packet design §7.1 step 8. Resolves the rest of Appendix A.3 gap 10 —
`pending[0]` is the lexicographic selection CONTROL-FAIRNESS says to correct;
`dispatch-policy.ts` and `quota-policy.ts` are uncalled; `maxDispatches` is
parsed and unused; `ResidentHost`'s default sleep resolves only on abort.

**Files:**

- Modify: `src-next/control-plane/application/advance-once.ts`
- Modify: `src-next/control-plane/contracts/config.ts`
- Modify: `src-next/control-plane/domain/quota-policy.ts`
- Modify: `src-next/control-plane/infrastructure/resident-host.ts`
- Modify: `src-next/control-plane/application/schedule-service.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Modify: `test-next/e2e/scenarios/{fairness,quota-pause,schedule-restart,tick-resident-equivalence,recover-active-run}.test.ts`

**Interfaces:**

- Consumes: `DispatchPolicy.select(candidates, state)`
  (`dispatch-policy.ts:20`), `QuotaPolicy.decide(now, dispatches, pausedUntil)`
  (`quota-policy.ts:14`), `ControlEventType.DispatchPaused` with its existing
  `reason` field.

- [ ] **Step 1: Write the failing host-policy tests**

Extend the composed scenarios:

```ts
it('selects by requested global position, not lexicographic activation id');
it('counts dispatches from durable Run records over a trailing window');
it('survives restart with the dispatch window intact');
it('pauses on operator request and on quota with the same event and a distinct reason');
it('resumes only after the clock reaches the persisted deadline');
it('backs off when idle up to the configured ceiling and resets on any progress');
it('reconciles an active Run at startup before dispatching anything new');
```

- [ ] **Step 2: Run and confirm the policies are uncalled**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/fairness.test.ts test-next/e2e/scenarios/quota-pause.test.ts
rg -n 'DispatchPolicy|QuotaPolicy' src-next --glob '!**/domain/**'
```

Expected: FAIL; the `rg` returns nothing, proving both policies are unreachable
from any composition.

- [ ] **Step 3: Replace `pending[0]` with the dispatch policy**

In `src-next/control-plane/application/advance-once.ts:86`, build
`DispatchCandidate`s from pending activations — `requestedPosition` is the
requesting event's global position, `hasActiveRun` from Execution,
`cancelled` from Work — and select through `DispatchPolicy`. The recovery branch
at `:69-85` runs first and is unchanged: an unaccepted completed Run is
reconciled before anything new is dispatched (EXEC-RECOVERY).

- [ ] **Step 4: Add the dispatch window and resident cadence to config**

```ts
export interface ControlPlaneConfig {
  readonly dispatch: { readonly windowMs: number; readonly maxDispatches: number };
  readonly schedules: readonly ScheduleConfig[];
  readonly resident: { readonly intervalMs: number; readonly maxIntervalMs: number };
}
```

`maxDispatches` is currently a flat integer with no window; legacy counts
invocations from durable Run records over a trailing window so the breaker
survives restart. `resident` currently has only `idleBackoffMs`; legacy has a
base cadence and a backoff ceiling that any progress resets.

- [ ] **Step 5: Add the operator pause gate (A5)**

Operator pause emits `ControlEventType.DispatchPaused` with a distinct `reason`,
reusing the existing event and its persisted deadline projection rather than
adding a second mechanism. No process-local timer is authoritative. `ResidentHost`
gains a real interval and a backoff ceiling, both injectable for deterministic
tests, and consults the pause deadline before each tick.

- [ ] **Step 6: Compose the remaining hosts**

Wire `RecoveryService`, `createRecoveryCoordinator`, run liveness, active-run
cancellation, and `ScheduleService` into `createCompositionRoot`, with
`ScheduleService` receiving the `ResourceLookup` and `IdGenerator` Step 1
introduced.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/control-plane test-next/e2e
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS, including the pre-existing `E2E-CONTROL-001..003` and
`E2E-SCHEDULE-001`.

```powershell
git add src-next test-next
git commit -m "feat: enforce fairness, dispatch limits, and pause gates in the composed hosts"
```

**Gate:** Two eligible WorkItems alternate by ready position; a watcher cannot
monopolise the global budget. A quota pause and an operator pause both survive
restart and neither consumes Run retry budget.

---

## Task 25A.9: Process-level fake E2E from an on-disk fixture Wake root — Complete

Packet design §7.1 step 9 and review §5. Resolves review §A.4 item 4 — the
existing scenarios run on `test-next/e2e/support/world.ts`, only
`api-domain-shape` and `configured-workflow` call `createCompositionRoot`, and
none goes through `src-next/main.ts` from an on-disk root.

**Files:**

- Create: `test-next/e2e/fixtures/wake-root/config.yaml`
- Create: `test-next/e2e/fixtures/wake-root/config.workflows.yaml`
- Create: `test-next/e2e/fixtures/wake-root/provider/evidence.json`
- Create: `test-next/e2e/support/process-world.ts`
- Create: `test-next/e2e/scenarios/live-simple.test.ts` (E2E-LIVE-001, -002)
- Create: `test-next/e2e/scenarios/live-dark-factory.test.ts` (E2E-LIVE-003, -004)
- Create: `test-next/e2e/scenarios/live-eligibility.test.ts` (E2E-LIVE-005)
- Create: `test-next/e2e/scenarios/live-guards.test.ts` (E2E-LIVE-006, -007)
- Create: `test-next/e2e/scenarios/live-recovery.test.ts` (E2E-LIVE-008)
- Create: `test-next/e2e/scenarios/live-intake-delivery-identity.test.ts` (E2E-LIVE-009)
- Create: `test-next/e2e/scenarios/live-issue-publication.test.ts` (E2E-LIVE-010)
- Create: `test-next/e2e/scenarios/live-provider-contract.test.ts` (E2E-LIVE-011)
- Modify: `src-next/integrations/fake/provider.ts`

**Interfaces:**

- Consumes: `main(argv, dependencies)` from `src-next/main.ts:16`, which parses a
  command, resolves `wakeRoot`, composes, and runs.
- Produces: `createProcessWorld(fixture)` giving a temp Wake root, a fake clock,
  a durable provider evidence file, a durable delivered-effects file, and helpers
  to run `tick` / `start` and to restart mid-run.

- [ ] **Step 1: Write the failing process-level scenario**

Create `test-next/e2e/scenarios/live-simple.test.ts`. Describe the flow in
Given/When/Then structure, per the target-architecture rules:

```ts
describe('E2E-LIVE-001 simple workflow through the composed process', () => {
  it('takes fake provider evidence to done and delivers one effect exactly once', async () => {
    // Given a Wake root on disk with one provider instance and a refine→implement workflow
    const world = await createProcessWorld('wake-root');
    await world.provider.publishIssue({ key: 'demo#1', title: 'Improve intake', tags: ['bug'] });

    // When the composed process runs ticks until the workflow completes
    await world.runTicksUntilIdle();

    // Then one WorkItem exists and carries a minted identity
    const work = await world.readProjection('work');
    expect(work).toHaveLength(1);
    expect(work[0].workItemId).toMatch(/^work-[0-9a-hjkmnp-tv-z]{26}$/);

    // And its workflow reached completion. Assert the WorkflowInstance status,
    // not WorkStatus: nothing in Orchestration or Control Plane closes a
    // WorkItem when a workflow completes, and WORK-LIFECYCLE deliberately keeps
    // workflow position off the WorkItem. Asserting WorkStatus.Closed here would
    // be an assertion about behaviour this packet does not build.
    const workflows = await world.readProjection('orchestration');
    expect(workflows).toHaveLength(1);
    expect(workflows[0].status).toBe(WorkflowStatus.Completed);

    // And exactly one effect was delivered
    expect(await world.provider.deliveredEffects()).toHaveLength(1);

    // And running further ticks delivers nothing more
    await world.runTicksUntilIdle();
    expect(await world.provider.deliveredEffects()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm no process-level world exists**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/live-simple.test.ts
```

Expected: FAIL resolving `../support/process-world.js`.

- [ ] **Step 3: Build the fixture Wake root**

Per review decision 4, 25A provisions its Wake root from a committed on-disk
fixture, not `wake init` (Task 26). Two files only, per A3 — `config.yaml` then
`config.workflows.yaml`, deep-merged in that order, with no other discovery:

```yaml
# test-next/e2e/fixtures/wake-root/config.yaml
schemaVersion: 1
execution:
  agentRunners:
    fake: { kind: fake, timeoutMs: 5000 }
  tiers: { standard: [fake] }
  defaultTier: standard
controlPlane:
  resident: { intervalMs: 10, maxIntervalMs: 50 }
  dispatch: { windowMs: 3600000, maxDispatches: 20 }
integrations:
  demo:
    provider: fake
    enabled: true
    evidenceFile: provider/evidence.json
    effectsFile: provider/effects.json
    intake:
      - where: { kind: issue, requiredAssignees: [wake-bot] }
        tags: [bug]
      - where: { kind: pull-request }
        tags: [review]
surfaces:
  api: { enabled: false }
  web: { enabled: false }
```

```yaml
# test-next/e2e/fixtures/wake-root/config.workflows.yaml
orchestration:
  retry: { maxFailureRetries: 5, maxChangesRequestedRetries: 3 }
  workflowSelectors:
    - match: { tags: [review] }
      workflow: review
    - match: { tags: [bug] }
      workflow: default
  default: default
  workflows:
    default:
      entry: refine
      stages:
        refine:
          activity: agent
          with: { prompt: refine the objective }
          execution: { workspace: none, tier: standard }
          on:
            done: { then: implement }
            blocked: { then: blocked }
        implement:
          activity: agent
          with: { prompt: implement the objective }
          execution: { workspace: branch, tier: standard }
          on:
            done:
              activities:
                - use: status.publish
                  with: { body: implementation complete }
              then: done
            failed: { then: implement, retry: { max: 3 } }
    review:
      entry: assess
      watches:
        - id: pr-review
          while: { stages: [implement], statuses: [waiting] }
          on: { events: [execution.run-succeeded] }
          workflow: review
          maxPerGroup: 3
      stages:
        assess:
          activity: agent
          with: { prompt: assess the pull request }
          execution: { workspace: none, tier: standard }
          on:
            done: { then: implement }
            blocked: { then: blocked }
        implement:
          activity: agent
          with: { prompt: implement the approved pull request }
          execution: { workspace: branch, tier: standard }
          on:
            done:
              await:
                signal: approval
                from: [{ kind: watch, id: pr-review }]
              activities:
                - use: pr.approve
                - use: pr.merge
                  with: { method: squash, requireChecks: true, maxFilesChanged: 10 }
              then: done
            failed: { then: implement, retry: { max: 3 } }
```

Per finding F5, stages name the single registered `agent` Activity with
`with: { prompt }`; 25B step 10 replaces that with `with: { template }`. Per
F8, the `implement.done` route also runs `status.publish` with a fixed body
before reaching `done`; the durable fake runner evidence returns `done` for
both `agent` stages.

- [ ] **Step 4: Build the process world with durable fakes**

`createProcessWorld` copies the fixture into a temp directory, then drives
`main(['tick', '--wake-root', root], { compose, output, signal })` — the real
entrypoint, not a hand-assembled root. The fake provider reads its evidence from
`provider/evidence.json` and appends delivered effects to `provider/effects.json`
inside the Wake root, so both survive a simulated process restart. No isolated
service mocks and no real Git.

- [ ] **Step 5: Add the two scenarios the review matrix lacks**

`live-intake-delivery-identity.test.ts` (**E2E-LIVE-009**) is the scenario that
would have caught Appendix A.3 gap 2. It must not author a resource fixture:

```ts
// Given no prior state, When the process observes one issue and completes a
// stage that publishes a status, Then the delivered effect targets the exact
// Resource identity intake created in this same run.
const created = await world.readProjection('resources');
expect(created).toHaveLength(1);
const effects = await world.provider.deliveredEffects();
expect(effects).toHaveLength(1);
expect(effects[0].externalKey).toBe(created[0].externalKey.key);
expect(effects[0].resourceId).toBe(created[0].resourceId);
```

`live-issue-publication.test.ts` (**E2E-LIVE-010**) proves a non-PR publication:
a status comment on a `commentable`, non-`revisioned` issue-thread Resource is
delivered with an issue-thread target and no pull-request number. Both defects
in §4 — the key-format mismatch and the forced `pull_number` — fail these two
scenarios and only these two.

- [ ] **Step 6: Add the remaining matrix scenarios**

Build E2E-LIVE-002 through -008 and -011 against the same process world, per the
scenario matrix above. E2E-LIVE-011 registers a second fake provider instance
whose state synchronization uses a native status field with no labels and no
slash commands, proving the shared seam by capability coverage rather than by
provider role (review §6.7).

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e
npm run check:catalogue
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS.

```powershell
git add src-next/integrations/fake test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "test: prove the live loop end to end from an on-disk Wake root"
```

**Gate:** the packet gate below.

---

## Packet gate — Task 25A

Task 25A closes when all of the following hold. Task 25B is gated behind this
gate, and Task 26 is blocked until both packets close.

**Completion recorded 2026-08-01.** Task 25A and Task 25B are complete, so
Task 26 is no longer blocked by either Task 25 packet. The unchecked bullets
below preserve the original gate wording; the verified completion status and
current verification counts are recorded in the implementation-status table.

- [ ] A composed process started from an on-disk Wake root observes fake
      provider evidence, creates and progresses work, executes a runner, records
      durable state, and delivers one fake effect exactly once.
- [ ] Every scenario in the matrix passes, including **E2E-LIVE-009** (the
      effect targets the identity intake created in the same run) and
      **E2E-LIVE-010** (a non-PR issue-thread publication).
- [ ] No production code derives a WorkItem or Resource identity from an
      external value: `rg -nE "(workItemId|resourceId)\(\`" src-next` is empty.
- [ ] No production file outside `src-next/integrations/github/**` mentions
      GitHub: `rg -il github src-next | rg -v 'github[\\/]'` is empty, and
      `npm run lint:contracts` fails if a provider name reaches a `work.*` or
      `resource.*` value.
- [ ] `npm run check:catalogue` passes with the six new mandated families and the
      2026-08-01 disposition-review line.
- [ ] `npm run lint:contracts`, `npm run lint:architecture`,
      `npm run knip:next`, `npm run verify:next`, and `npm run verify` all pass.
- [ ] `knip:next` reports nothing — in particular none of Appendix A.3 gap 14's
      fifteen services remains unreachable.
- [ ] Every exported `ProjectionDefinition` is registered in
      `runtimeProjectionDefinitions` (finding F7), and deleting `.wake/state/`
      then replaying reproduces all of them identically to the live fold.
- [ ] Target test counts exceed the `2bfeced` baseline of 119 files / 498 tests
      with web at 7 / 17, and no baseline test was weakened to pass.
- [ ] `CLAUDE.md` no longer mandates `--max-turns`; the corrective design §3.1
      uses catalogue vocabulary only.

**Explicitly not in this packet.** Prompt templates and frontmatter validation,
runner fidelity (flags, wall-clock enforcement, structured output, session
capture and resume, token and cost usage, quota-versus-infrastructure failure
classification), GitHub state synchronization and echo suppression, outbound
idempotency markers, watermarks and ETag-aware polling, quota pause with
reported reset times and alternate runner selection, and the manual real-GitHub
acceptance script. All are 25B steps 10–14.

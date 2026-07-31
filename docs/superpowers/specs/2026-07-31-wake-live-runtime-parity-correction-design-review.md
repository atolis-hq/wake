# Review — Wake Live Runtime Parity Correction Design

**Reviewed design:** `docs/superpowers/specs/2026-07-31-wake-live-runtime-parity-correction-design.md`
**Rewrite plan:** `docs/superpowers/plans/2026-07-30-wake-target-architecture-rewrite.md`
**Reviewer:** architecture review, 2026-07-31
**Status of this document:** point-in-time review record (historical; not a reference doc).

---

## 1. Verdict

**Approve with required changes.** The design is well-grounded and its central
factual claims are verifiably true against the code (see §8, verification). It
correctly identifies the real defect — a composition root that assembles domain
services but no live loop — and the real coupling — GitHub leakage into shared
Integration seams. It respects the target's journal-first, domain-boundary
invariants. Four required changes must be applied before the packet is planned;
the operator decisions of 2026-07-31 (recorded in §2) resolve the open
questions the first review raised.

### Confirmed claims

| Design claim | Evidence in code | Status |
| --- | --- | --- |
| Composition root does not assemble a live process (§1) | `src-next/bootstrap/composition-root.ts` wires journal/projections/work/resources/orchestration/execution/advanceOnce, but constructs an **empty** `new ActivityRegistry()` (no agent/PR activities), **no** runners, **no** provider/poll/delivery, **no** tick/resident/schedule/recovery hosts | Confirmed |
| GitHub leaks outside the GitHub namespace (§4) | `integrations/contracts/identifiers.ts` exports `GitHubAdapterId` + `BuiltInAdapterId.GitHub`; `integrations/contracts/config.ts` hardcodes a top-level `github` subtree; `integrations/index.ts` re-exports `./github/*` from the shared barrel; 32 `test-next` files reference `github`, including architecture/bootstrap/resources/kernel/e2e fixtures | Confirmed — matches §3.4's forbidden-names list exactly |
| The shared seam may rely on GitHub semantics (§3.4) | `integrations/fake/external-source.ts` — the "provider-neutral" fake — imports `ExternalEventSource` and `GitHubAdapterEventDraft` **from the github namespace**; the generic poll port itself lives at `integrations/github/application/poll-service.ts` | Confirmed — this is type-level coupling, not only naming |
| Target design mandates provider-agnostic integrations but never specifies a concrete provider-registry seam | Target design §6 `integrations` "owns provider adapters" generically; principle stated, mechanism absent | Confirmed — so §3.4's registry requirement is new architecture (see RC-2) |

## 2. Operator decisions — 2026-07-31

These decisions are agreed and govern the corrective packet:

1. **Vocabulary.** Use the **existing** disposition vocabulary only —
   `preserve`, `correct`, `consolidate`, `remove`, `defer`. Do **not** introduce
   `replicate now`, `adjust`, `ignore`, or any umbrella synonym. The approved
   catalogue and its `check:catalogue` gate remain authoritative. (Resolves RC-1.)
2. **No real Git in automation.** All real-GitHub acceptance is **manual**.
   Automated proof is entirely fake-boundary. (Resolves §7.2 automation scope.)
3. **Legacy code is the behavioural guide** — especially its **exception /
   error handling**. Ambiguous external or process state must not be converted
   into assumed failure-and-retry; this is `correct`-disposition behaviour to
   preserve (catalogue rows EXEC-RECOVERY, EXEC-CANCEL). (Feeds §4/§7.)
4. **Hand-rolled config for this stage.** 25A provisions its Wake root from a
   committed on-disk fixture, not `wake init` (which stays in Task 26).
   (Resolves RC-3 provisioning.)
5. **Config translation must be explicitly agreed** — a documented legacy→target
   mapping with a clear rationale per decision (see §4). (Strengthens §5.)
6. **E2E simulation scope is fixed** — two workflows (simple `refine→implement`
   and the dark-factory equivalent), each covering a happy path and a
   failure→reject→refine→recover path, plus proof that ineligible items are not
   processed, plus loop-guard and retry-cap protection (see §5).
7. **UI tunnel is a required capability, modeled as a follow-on activity** — not
   surface config and not deferred. The operator-reachable UI URL is a
   provider-neutral publication intent emitted by a follow-on activity; GitHub
   owns the comment-header link formatting. The ngrok process lifecycle (start,
   discover URL) is host/ops infrastructure the activity depends on and rides
   with sandbox/ops (Task 26).
8. **No real GitHub in any tooling.** All real-GitHub acceptance is a human
   following a documented script and confirming by inspection. Wake's automated
   and agentic tooling must never call real GitHub. Merge is proven via the fake
   only; there is no real merge.

The §4 config-translation table dispositions are accepted as recorded (`paths`
→ `remove`, `ui` token gating → `remove` with the tunnel per decision 7,
`sandbox` → `defer`, `retry` and `dispatchRateLimit` → `preserve`, `commands` →
`correct` under Orchestration).

## 3. Required design changes

Wording below uses the existing disposition vocabulary only (decision 1).

**RC-1 — Vocabulary reconciliation (blocker).**
§3.1 lists four dispositions (`replicate now`/`adjust`/`defer`/`ignore`) and
§7.2/§8 depend on the term `replicate now`; the approved catalogue and
`scripts/check-functional-catalogue.mjs` accept only
`preserve`/`correct`/`consolidate`/`remove`/`defer`. Any 25A row in the design's
vocabulary fails `npm run check:catalogue`.
*Apply:* In §3.1 strike the four-item list and state — "Every reviewed item
carries exactly one catalogue disposition: `preserve`, `correct`,
`consolidate`, `remove`, or `defer`. The existing `check:catalogue` gate remains
authoritative and no new disposition vocabulary is introduced." Then rewrite
every later occurrence: `replicate now` → "dispositioned `preserve`, `correct`,
or `consolidate`"; `ignore` → `remove`. §8's gate bullet becomes "manual
acceptance evidence for every real-provider capability dispositioned `preserve`,
`correct`, or `consolidate`."

**RC-2 — Record the provider-registry seam as a dated amendment; relocate the
intake port out of the GitHub namespace (blocker).**
§3.4 requires a generic provider-plugin contract, but the target design only
states the principle and the current code contradicts it (github-named shared
config, a github-typed fake, poll port inside `integrations/github/`). Per the
design's own §3.2 this is an architecture change.
*Apply:* Add to §3.4 — "Introducing the concrete provider-plugin/registry
contract is an architecture change and MUST be recorded as a dated amendment
under §3.2 before implementation. The amendment must (a) move the generic
polling/intake port and its inbound event-draft contract out of
`integrations/github/**` into a provider-neutral Integration contract, (b)
re-type the fake provider against that neutral contract, and (c) replace the
shared `integrations.github` config subtree with a provider-keyed map validated
per registered provider."

**RC-3 — Close the 25A ↔ Task 26 boundary (required).**
§7.1's process-level fake E2E and §7.2's manual check both depend on artefacts
built in Task 26 (`scripts/e2e-github-fake.ts` Step 5; `wake init` Step 3).
*Apply:* Add to §8 — "Task 25A owns the process-level fake E2E and the
provider-boundary contract test; the operational-command port (`init`,
`doctor`, `sandbox`, `self-update`, `smoke`) remains Task 26. 25A provisions its
Wake root from a committed on-disk fixture, and Task 26 later retargets
`scripts/e2e-github-fake.ts` onto the 25A composition without re-proving the
loop."

**RC-4 — Name quota/pause-window reconciliation (should).**
The resident quota / pause-window mechanism (catalogue CONTROL-QUOTA; the
operator plan-budget constraint) is only implicit in §6's "bounded work per
tick." *Apply:* add "resident quota and pause-window reconciliation" to the
§4 inventory bullet on tick/resident hosts and to the §6 composition list.

## 4. Configuration-translation agreement (proposed — requires sign-off)

Per decision 5, the packet must publish this mapping with rationale before
implementation. Legacy sections are from `docs/configuration.md`; target owners
are from the rewrite plan Task 24 shape amended by RC-2. Dispositions use the
existing vocabulary. This table is the **starting proposal**; each row needs an
explicit accept/adjust decision.

| Legacy config | Target owner / field | Disposition | Rationale for the transition |
| --- | --- | --- | --- |
| `paths` | `bootstrap/paths.ts` (derived from `wakeRoot`) | `remove` | `wakeRoot` was never user-set (always derived), so no loss. The only user-facing setting removal drops is `promptsRoot` (custom prompt-template location); `remove` fixes templates at `<wakeRoot>/prompts`. `.wake/*` layout is otherwise fixed. |
| `runners` | `execution.runners` | `preserve` | Runner definitions are Execution-owned. Same intent (named runner instances); moved to the owning module's subtree. |
| `tiers` / `defaultTier` | `execution.tiers` / `execution.defaultTier` | `preserve` | Tier routing is an Execution concern. Field semantics unchanged. |
| `retry` | `orchestration` retry policy (`retry-policy.ts`) | `correct` | Retry caps belong to Orchestration, not a global block. Behaviour preserved; ownership corrected so retry cannot be applied outside workflow policy. |
| `scheduler` | `controlPlane.schedules` | `preserve` | Scheduling is a control-plane concern; same schedule semantics under the owning module. |
| `workflows` | `orchestration.workflows` | `correct` | A legacy stage blends three concerns — agent action, routing/watches, and deterministic effect actions (`onSuccess.approve`/`merge`). The target un-blends them: `activity`+`with` (Activities), `execution.{workspace,tier}` (Execution), `on.<outcome>.{activities,then,repeat,retry}` (Orchestration). `onSuccess` effects become explicit follow-on activities. See §4.1 for the stage decomposition and the merge-policy split. |
| `transcripts` | `execution` transcript retention | `preserve` | Transcript capture/retention is Execution-owned; retention policy unchanged. |
| `sources.github` | `integrations.<providerId>` (provider-keyed map; github subtree) | `correct` | Corrects the top-level `integrations.github` literal (§3.4). Same GitHub observation policy, now nested under a provider key so Jira/Linear/GitLab add a sibling key without a schema rewrite. |
| `ui` | `surfaces.api` / `surfaces.web` | `correct` | UI/API host settings move to Surfaces. Legacy `ui.token` bearer gating is `remove` (v1 is unauthenticated, loopback-scoped per Task 25). **`ui.tunnel` is a required capability modeled as a follow-on activity** (decision 7): the operator-reachable URL is a provider-neutral publication intent, GitHub owns the comment-header link, and the ngrok process lifecycle is host/ops infrastructure (Task 26). |
| `commands` | `orchestration` supplemental commands (`workflowDefinitionConfigSchema.commands`) | `correct` | The legacy `commands` block is **custom slash-commands** (`/ask`, `/codereview`) mapping human comments to actions — not runner CLI settings (those live inside `runners`). Re-owned to Orchestration's supplemental commands, which add `allowedActors` authority and keep the legacy rule that a custom command does not advance workflow stage. Reserved control commands (`/approved`, `/changes`, `/interrupt`) are signals, not custom commands, and the provider owns the slash syntax. Open: legacy per-command `workspace`/`tier` hints have no home in the current `supplementalCommandConfigSchema`. |
| `sandbox` | Surfaces operational commands (Task 26) | `defer` | Sandbox/Docker config is operational and deferred to Task 26; excluded from 25A's live-runtime scope, not lost. |

Decisions still needing operator sign-off are listed in §6.

### 4.1 Stage decomposition — the workflows/actions blend

The legacy `config.workflows.yaml` fuses three concerns into one stage block,
and its `onSuccess.merge` block additionally embeds GitHub-specific delivery and
policy into the workflow file. The target (already implemented in
`src-next/orchestration/contracts/config.ts`) separates them by owner. This is
the plan going forward; the decomposition is not new design.

Legacy (blended):
```yaml
implement:
  action: implement          # agent action
  workspace: branch          # execution hint
  onDone: done               # routing
  watch:
    - ...                     # child-workflow trigger
      onSuccess:
        merge:                # deterministic effect + GitHub policy/delivery
          approve: true
          autoMerge: true
          mergeMethod: SQUASH
          maxFilesChanged: 10
          blockedPaths: [ ... ]
          blockedLabels: [ security ]
```

Target (un-blended):
```yaml
implement:
  activity: implement                 # Activities own/validate `with`
  execution: { workspace: branch, tier: standard }   # Execution validates
  on:                                 # Orchestration validates routing
    done:
      activities:                     # explicit, journalled follow-on activities
        - use: pr.approve
        - use: pr.merge
          with: { target: primary, method: squash, requireChecks: true }
      then: done
# child triggers move to `watches:`; human `/commands` move to `commands:`
```

Ownership after decomposition: agent action → `activity`+`with` (Activities);
workspace/tier → `execution` (Execution); routing/`then`/`repeat`/`retry` and
`watches`/`commands` → Orchestration; `onSuccess.approve`/`merge` → follow-on
`pr.approve`/`pr.merge` activities (target design §8.2–§8.3).

**Merge-policy split (not fully modelled yet — needs disposition).** The target
`pr.merge` authority gate (`decidePullRequestAuthority`) currently covers only
review authority, checks, and correlation/revision. The legacy
deterministic-merge policy fields land in three different owners:

| Legacy `onSuccess.merge` field | Target home | Proposed disposition |
| --- | --- | --- |
| `mergeMethod` (`SQUASH`/`MERGE`/`REBASE`) | neutral `pr.merge.with.method`; GitHub maps naming | `preserve` |
| `autoMerge` + queue-rejected→direct-merge fallback | GitHub delivery behaviour; neutral intent is "merge when green" via `requireChecks` | `consolidate` into GitHub delivery |
| `maxFilesChanged`, `blockedPaths` | provider-neutral `pr.merge` policy — **not yet in target** | `correct` (new) or `defer` |
| `blockedLabels` | label-based ⇒ provider concept under §3.4; may not name labels in workflow config — must be GitHub-owned or re-expressed as a neutral signal | decision needed (§6.4) |

### 4.2 Generality of the shared identity seam (resource id + type, not role names)

The shared seam should generalize on *identity* and stay closed on *behaviour*.
The target already largely does this and must not regress.

Already general (keep):

- `ExternalResourceKey { adapter: string, key: string }` — opaque provider,
  opaque external key. No role or provider name in the type.
- `ResourceKind` is an open registry (`ResourceKindRegistry`);
  `repository`/`issue`/`pull-request` are registrable built-ins, not a closed
  set. A provider may register `merge-request`, `ticket`, `card`, etc.
- Canonical `ResourceId` is Wake-owned; the external system is only `{adapter, key}`.
  No typed "ticketing id" is needed — a provider is an opaque `adapter`.

Go **more** general (apply here):

- **Gate PR activities on capability, not kind.** `activities/pr/policy.ts`
  (`isPrimaryPullRequest`) branches on `kind !== 'pull-request'`; a GitLab
  merge-request (`mergeable`) would be wrongly rejected. `pr.approve`/`pr.merge`/
  review must require `mergeable`/`reviewable`/`approvable` capabilities and
  never a concrete kind literal. (`'pull-request'` is provider-neutral, so this
  is a generality fix, not a §3.4 violation.) — see §6.6.
- **One capability-driven fake, not role-named fakes.** Replace §3.4's
  `fakeTicketing`/`fakeSourceControl`/`fakePr` with a single `fakeProvider`
  (opaque adapter `fake`) exposing an issue-like resource (`commentable`) and a
  PR-like resource (`reviewable`/`approvable`/`mergeable`/`revisioned`). The
  contract test proves the seam by capability coverage, not provider role. — see §6.7.

Keep closed/typed (do **not** generalize to open strings or `Record`):

| Concept | Keep as | Why |
| --- | --- | --- |
| `ResourceCapability` behavioural set | closed built-in vocabulary | Activities branch on it; open string loses safety |
| Activity resource requirements | capability-typed | The provider-agnostic hinge; require `mergeable`, not "type = pr" or "any resource" |
| Delivery-intent vocabulary | closed provider-neutral set | Provider must exhaustively translate each intent |
| Correlation role (`primary`/`secondary`) | closed | already `defineClosedVocabulary` |
| Domain entity ids (`WorkItemId`, `RunId`, …) | branded/typed | `EntityRef{kind,id}` is generic transport; domain stays branded |
| `ResourceKind` | open registry, but behaviour never branches on a kind literal | Extensible is fine; `if kind === 'x'` re-couples (the PR-policy fix above) |

The provider role distinction in design §3.3 (ticketing vs source-control) is a
config/registration grouping only; it must not become a domain type that
behaviour branches on.

## 5. E2E simulation matrix (per decision 6)

All E2E runs use the composed production bootstrap over the journal, real
projections/checkpoints, durable fakes, and the fake provider boundary — no
isolated service mocks, no real Git. Both workflows must run from the
hand-rolled on-disk config through the target entrypoint.

| Workflow | Happy path | failure→reject→refine→recover | Reuses / extends |
| --- | --- | --- | --- |
| **Simple:** `refine → implement` | intake → refine outcome → implement → done, one fake effect delivered once | implement returns a reject/blocked outcome; agent feedback is addressed on the next attempt; workflow recovers to done without duplicating effects | `golden-path`, `configured-workflow`, `blocked-reply` |
| **Dark-factory equivalent:** intake/triage → implement → review → `pr.approve` → `pr.merge` | full autonomous chain; approval bound to the exact revision; one merge intent delivered once | review requests changes; a new revision is produced; stale approval is invalidated and re-established against the new revision before merge | `pr-approval`, `pr-merge-delivery`, `stale-approval`, `pr-trust` |

Cross-cutting scenarios that must also pass on the composed runtime:

- **Ineligible items are not processed.** An item failing provider eligibility
  (and a bot/self-authored comment) produces no WorkItem, Run, or effect.
  (Extends `external-intake`; asserts absence, not just presence.)
- **Loop protection.** A child/watch cycle that would re-trigger itself is
  stopped by the group budget; a successful child does not reset the budget.
  (Reuses `child-loop-guard`, catalogue ORCH-WATCH / `E2E-ORCH-LOOP-001`.)
- **Retry protection.** Retries are capped by Orchestration policy; an exhausted
  cap escalates rather than looping. (Reuses `retry-boundary`, ORCH-TRANSITION /
  `E2E-ORCH-RETRY-001`.)
- **Recovery / exception handling (decision 3).** Restart mid-Run, and an
  ambiguous external/process outcome, must reconcile to an explicit state — never
  silently assume failure-and-retry. (Reuses `recover-active-run`,
  `journal-restart`, `outbox-crash`; catalogue EXEC-RECOVERY / EXEC-CANCEL.)

## 6. Questions requiring human product decisions (remaining)

Decisions 1–8 (§2) resolve the first review's open questions. Status:

1. **Config-translation table (§4). RESOLVED** — accepted as recorded (§2). The
   `commands` row is corrected to Orchestration supplemental commands (not
   Execution). The UI tunnel is a required follow-on activity (decision 7).
2. **Provider-keyed config shape (RC-2/§4). RESOLVED** — provider-keyed map
   approved; `integrations.github` literal is replaced so adding
   Jira/Linear/GitLab needs no second rewrite.
3. **Real-GitHub acceptance. RESOLVED (decision 8)** — no Wake tooling calls
   real GitHub. A human follows a documented script and confirms by inspection.
   Merge is proven via the fake only; there is no real merge.
4. **Merge-policy fields (§4.1). RESOLVED.** `maxFilesChanged`/`blockedPaths`
   are in scope for 25A as provider-neutral `pr.merge` policy (`correct`).
   `blockedLabels` is re-expressed as a neutral "merge-blocked" signal the
   GitHub provider emits from its own labels and `pr.merge` policy consumes;
   labels stay inside GitHub per §3.4.
5. **Supplemental-command execution hints. RESOLVED.** Add an
   `execution: { workspace, tier }` block to `supplementalCommandConfigSchema`
   to preserve legacy `/codereview`-style read-only/tiered runs.
6. **Capability-gate PR activities (§4.2). RESOLVED.** `activities/pr/policy.ts`
   gates on `mergeable`/`reviewable`/`approvable` capability, not
   `kind === 'pull-request'`. Requires a target scenario proving a non-GitHub
   `mergeable` resource merges through the same path (§5 dark-factory fake).
7. **Single capability-driven fake (§4.2). RESOLVED.** One `fakeProvider`
   replaces the role-named fixtures; the provider-boundary contract test proves
   the seam by capability coverage.

## 7. Is Task 25A sufficiently bounded to plan?

**Yes, once RC-1–RC-3 and the §4 table are signed off.** The intent is tightly
scoped: no new domain capability — only (a) composition wiring of already-built
modules, (b) the provider-neutral seam + GitHub-locality static check + fixture
renames, (c) one non-GitHub fake-provider contract test, and (d) the
process-level fake E2E matrix of §5 plus the manual acceptance script. It is the
broadest packet in the plan (every host composed plus a cross-cutting seam
refactor), so the eventual plan should sub-sequence it: provider-neutral seam +
locality check → bootstrap activity/runner/host/delivery wiring → process-level
fake E2E → provider contract test → manual acceptance. The design's §8 seven-step
order already supports that.

## 8. How to review / verify the claims

Each claim in this review is independently checkable. Run from repo root.

**C1 — Composition root assembles no live loop.**
```
# Open the file and confirm: empty `new ActivityRegistry()`, no runner registry,
# no provider/poll/delivery, no tick/resident/schedule/recovery host construction.
sed -n '46,84p' src-next/bootstrap/composition-root.ts
```
Expect: only journal/projections/checkpoints/work/resources/orchestration/
execution/advanceOnce/projectionRunner; nothing from `integrations/*`,
`execution/infrastructure/runners/*`, or `control-plane/infrastructure/*`.

**C2 — GitHub leaks outside the GitHub namespace.** (Run in a POSIX shell; the
`grep` separator class matches both Windows `\` and POSIX `/` paths.)
```
rg -il github src-next | grep -vi 'github[\\/]'
```
Expect exactly four production files: `integrations/index.ts`,
`integrations/contracts/config.ts`, `integrations/contracts/identifiers.ts`,
`integrations/fake/external-source.ts`. Then confirm the forbidden names:
```
rg -n 'GitHubAdapterId|BuiltInAdapterId' src-next/integrations/contracts/identifiers.ts
rg -n 'github' src-next/integrations/contracts/config.ts
```

**C3 — The fake source is type-coupled to GitHub (not just named).**
```
sed -n '1,11p' src-next/integrations/fake/external-source.ts
```
Expect imports of `ExternalEventSource` and `GitHubAdapterEventDraft` from
`../github/...` — proving the shared intake seam borrows GitHub types.

**C4 — Disposition vocabulary mismatch (RC-1).**
```
grep -oE '\| (preserve|correct|consolidate|remove|defer|replicate now|adjust|ignore) \|' \
  docs/architecture/functional-decision-catalogue.md | sort | uniq -c
```
Expect only `preserve/correct/consolidate/remove/defer` in the catalogue;
compare against the design's §3.1 list (`replicate now/adjust/defer/ignore`).
Then confirm the checker's allowed set:
```
rg -n "allowed = new Set" scripts/check-functional-catalogue.mjs
```

**C5 — Target design specifies no concrete provider-registry seam (RC-2).**
```
rg -ni 'provider registry|provider-plugin|register.*provider' \
  docs/superpowers/specs/2026-07-30-wake-target-architecture-design.md
```
Expect no hits — only generic "provider adapters" language, confirming §3.4's
registry is new architecture requiring a §3.2 amendment.

**C6 — Legacy exception/recovery behaviour is the guide (decision 3).**
```
sed -n '1,60p' docs/execution-invariants.md
rg -l 'reconcile|ambiguous|stale' test/core/stale-run-reconciler.test.ts test/core/tick-runner.reconcile.test.ts
```
Confirms the "do not assume failure-and-retry from unknown state" constraint
that EXEC-RECOVERY/EXEC-CANCEL preserve.

**C7 — Existing E2E coverage the §5 matrix builds on.**
```
ls test-next/e2e/scenarios | rg 'golden|blocked|pr-|stale|retry|child-loop|recover|journal-restart|outbox|external-intake'
```
Confirms the reusable scenarios named in §5; the packet elevates these to a
process-level, from-disk composed run covering both workflows.

## 9. Closeout and readiness to build

This review is complete: verdict delivered, capability matrix recorded, required
changes specified with wording, and every human-decision question resolved
(decisions 1–8; opens §6.1–§6.7 all closed). The remaining work is to turn the
agreed design into buildable artifacts. Critical path, in order:

| # | Artifact | Owner | Gate to pass |
| --- | --- | --- | --- |
| 1 | **Finalize the design spec** — apply RC-1 (existing vocabulary only), RC-3 (25A/26 boundary), RC-4 (quota naming), and fold in decisions 7–8 and §6.4–§6.7 | reviewer (me) | spec self-consistent; no `replicate now`/`adjust`/`ignore` remain |
| 2 | **Write the dated provider-registry amendment** (RC-2, per design §3.2) — generic provider-plugin/registry contract, poll/intake port relocated out of `integrations/github/**`, provider-keyed config map, GitHub-locality static check | reviewer (me), operator sign-off | amendment dated and approved |
| 3 | **Update the functional-decision catalogue** — add/adjust rows for the §4 config translation, merge-policy (§4.1), capability-gating (§4.2), tunnel follow-on activity; then a **new dated disposition-review line** | reviewer drafts, **operator approves** | `npm run check:catalogue` passes; disposition-review line present |
| 4 | **Confirm the green baseline** | reviewer | `npm run verify:next` and `npm run verify` pass before any change |
| 5 | **Write Task 25A into the rewrite plan** — failing-test-first packet in design §8's 7-step order, with files, gates, and scenario IDs (§5) | separate planning activity (`writing-plans`) | plan reviewed; Packet-E gate defined |
| 6 | **Implement Task 25A** | build | §8 gate: composition + fake E2E + manual acceptance evidence |

Blocking dependencies: 5 needs 1–3 done; 3 needs operator approval before 6;
manual acceptance in 6 is human-run only (decision 8). Nothing here reopens a
resolved decision.

Immediate next action: items 1 and 2 (spec finalization + amendment), then draft
3 for operator approval. Item 5 (writing Task 25A) is the point at which this
review activity hands off to the planning activity.

# Granular legacy-to-target behavioural review

**Review point:** commits `1e3248c` and `3817545` (`2026-08-10`).  This is a
semantic review, not a source-shape comparison.  A result is **D** only where
the named target test asserts the legacy observable (including its boundary);
**C** means the catalogue deliberately changes/removes/defers it; **G** means
the target has no sufficiently specific proof.  Shared capability vocabulary
alone is never counted as a mapping.

## Target evidence used

The following are the principal direct proofs.  Line references identify the
registered assertion or the focused unit/integration assertion, and scenario
IDs identify the catalogue-linked test.

| Key | Target proof |
| --- | --- |
| T1 | `test-next/e2e/scenarios/external-intake.test.ts:28`, **E2E-WORK-002**, translates the same evidence twice and asserts one WorkItem/Resource/correlation. |
| T2 | `test-next/e2e/scenarios/work-resource-correlation.test.ts:13`, **E2E-WORK-001**, asserts correlation/retraction lookup semantics. |
| T3 | `test-next/e2e/scenarios/pr-correlation.test.ts:33`, **E2E-PR-001**, asserts verified primary PR correlation and rejects uncorrelated/conflicting evidence. |
| T4 | `test-next/e2e/scenarios/outbox-crash.test.ts:24,61,66`, **E2E-DELIVERY-001**, asserts accepted, unknown, and retry-after-crash external-effect boundaries. |
| T5 | `test-next/e2e/scenarios/fault-matrix.test.ts:46`, **E2E-FAULT-001**, injects faults at composed persistence/intake/dispatch/delivery boundaries and asserts replay or explicit exposure without duplicate effect. |
| T6 | `test-next/e2e/scenarios/recover-active-run.test.ts:10,76`, **E2E-EXEC-RECOVER-001/-002**, asserts restart after external completion and explicit resolution of unknown state. |
| T7 | `test-next/e2e/scenarios/cancel-active-run.test.ts:13`, **E2E-EXEC-CANCEL-001**, asserts cancellation across an Execution restart. |
| T8 | `test-next/integration/execution/process-execution.test.ts:26,44,62,83` asserts timeout classification, vendor passthrough, Claude flags, and absent/empty flags. |
| T9 | `test-next/e2e/scenarios/duplicates.test.ts:17`, **E2E-DUPLICATE-001**, asserts duplicate command/effect suppression at the composed boundary. |
| T10 | `test-next/e2e/scenarios/journal-restart.test.ts:13`, **E2E-JOURNAL-001**, and `projection-recovery.test.ts:18`, **E2E-PROJECTION-001**, assert ordered reopen/replay and projection rebuild without journal mutation. |
| T11 | `test-next/e2e/scenarios/tick-resident-equivalence.test.ts:6`, **E2E-CONTROL-002**; `fairness.test.ts:6`, **E2E-CONTROL-001**; `quota-pause.test.ts:6`, **E2E-CONTROL-003**; `schedule-restart.test.ts:6`, **E2E-SCHEDULE-001**. |
| T12 | `test-next/e2e/scenarios/security-boundaries.test.ts:18`, **E2E-SECURITY-001**; `stale-approval.test.ts:21`, **E2E-PR-002**; `pr-approval.test.ts:15`, **E2E-PR-APPROVE-001**; `pr-merge.test.ts:12,35,69,92`, **E2E-PR-MERGE-001/-002**; `pr-merge-delivery.test.ts:14`, **E2E-PR-MERGE-003**. |
| T13 | `test-next/e2e/scenarios/api-domain-shape.test.ts:38,77,102,127,154,227,286,315`, **E2E-SURFACE-001/-BOARD-001/-ANALYTICS-001**. |
| T14 | `test-next/e2e/scenarios/initialise-root.test.ts:13`, **E2E-OPS-INIT-001**; `doctor-rebuild.test.ts:16,56,86`, **E2E-OPS-001**; `sandbox-routing.test.ts:10`, **E2E-OPS-SANDBOX-001**; `self-update-packaged.test.ts:19`, **E2E-OPS-SELF-UPDATE-001**; `self-update-maintenance.test.ts:30,50,105,154,207,258,307,337`, **E2E-OPS-SELF-UPDATE-002/-003/-004/-005/-006/-007/-008**; `transcript-retention.test.ts:20`, **E2E-OPS-TRANSCRIPT-001**. |
| T15 | `test-next/integration/surfaces/cli-main-contract.test.ts:5` proves the process-entry CLI contract: bare/help aliases and version write their result without composing; unknown and incomplete commands reject before composition; an operational command dispatches once and writes its JSON line; and `init` uses a positional root while an explicit `--wake-root` takes precedence. |
| T16 | `test-next/integration/execution/workspace-recovery.test.ts` proves valid terminal/absent marker reclamation, Started/Ambiguous/unknown/malformed/out-of-root retention, continuation after cleanup errors, and idempotency; `test-next/e2e/scenarios/workspace-crash-recovery.test.ts` scenarios **E2E-EXEC-WORKSPACE-001/-002/-003** prove a fresh composed root reclaims a never-started owner before dispatch while maintenance pauses the sweep. |
| T17 | `test-next/integration/surfaces/web-server.test.ts:7,14,134` proves browser-history SPA fallback, non-masking API/static `404` boundaries, and static-method safety; `web-assets.test.ts:9` proves packaged hashed asset serving without a Wake-home write; `api-routes.test.ts:42` proves the API/browser route boundary. |
| T18 | `test-next/unit/bootstrap/version.test.ts` proves exact tag, tagged/untagged source, loose and packed/peeled Git-file, and development fallback resolution; `test-next/integration/surfaces/cli-main-contract.test.ts:20` proves that both version aliases publish the resolved build value without composing production services. |

## Per frozen path review

The “assertion groups” cell is deliberately behavioural: it lists every
distinct assertion family in the frozen file, rather than claiming that a
matching class/function is proof. `D` entries name the target assertion that
carries the comparable behaviour; `C` names the approved disposition; `G`
entries are concrete missing proof.

| Frozen legacy path | Assertion groups reviewed | Result and target/catal­ogue mapping |
| --- | --- | --- |
| `test/adapters/claude-runner.test.ts` | CLI argv, prompt/model/max-turn/tool forwarding, stdout/result parsing, exit/timeout errors | **D** T8 covers timeout and Claude flags/absence; **G-M1** does not prove legacy structured-output parsing or every legacy failure text. |
| `test/adapters/codex-runner.test.ts` | Codex argv/model/prompt, parse/failure/timeout | **D** T8 covers vendor passthrough and timeout; **G-M1** lacks a Codex-specific parse/error assertion. |
| `test/adapters/cursor-runner.test.ts` | Cursor argv/model/prompt, parse/failure/timeout | **D** T8 covers vendor passthrough and timeout; **G-M1** lacks a Cursor-specific parse/error assertion. |
| `test/adapters/docker-cli.test.ts` | source/packaged commands, mounts/auth, lifecycle, bounded logs/errors | **D** T14 sandbox route; **G-M2** lacks direct Docker command/mount/auth and bounded-log behavioural proof. |
| `test/adapters/fake-ticketing-system.test.ts` | fake issue lifecycle/effects | **D** T1/T4 use fake-provider intake and delivery. |
| `test/adapters/github-artifact-verifier.test.ts` | exact PR identity, trust/rejection | **D** T3/T12. |
| `test/adapters/github-auth.test.ts` | token/auth success/failure | **D** `test-next/integration/integrations/github-client-contract.test.ts` proves the configured-token Octokit setup and unchanged `401` authentication failure. It does not claim CLI credential-acquisition coverage. |
| `test/adapters/github-client.test.ts` | request shapes, pagination, errors, comments/labels/PR effects | **D** `github-client-contract.test.ts` proves bounded paginated issue-read request shape, conditional ETag reuse, exact merge/comment mapping, and unchanged outbound failure propagation. |
| `test/adapters/github-client-request-log.test.ts` | request log ordering/redaction | **D** `github-client-request-logging.test.ts` proves actual Octokit `429`/`500` diagnostics are redacted and `304` is quiet; it does not assert legacy request-log ordering. |
| `test/adapters/github-etag-cache.test.ts` | conditional request, cache hit/miss/invalidations | **D** `github-client-contract.test.ts` proves ETag-bearing issue reads send `if-none-match` on the following conditional read. |
| `test/adapters/github-issues-work-source.test.ts` | eligibility, labels, dedupe, marker reconciliation, issue lifecycle | **D** T1/T9 and `live-eligibility.test.ts:12` **E2E-LIVE-005** cover intake eligibility/dedupe; `github-client-contract.test.ts` covers the bounded issue request and ETag transport seam; **C** marker-family extraction is deferred by `FUTURE-STATE-SYNC-EXTRACTION`. |
| `test/adapters/github-pull-request-activity-source.test.ts` | PR observations, comment/review signals, trust/ordering | **D** T3/T12 plus the GitHub client contract suite cover provider operation and transport. The target suite does not claim a raw multi-page PR source-ordering compatibility contract. |
| `test/adapters/github-pull-request-merge-actor.test.ts` | merge request/method/result failure | **D** T12/T4 prove neutral intent, configured method, confirmation and ambiguity; `github-client-contract.test.ts` proves the exact GitHub merge request and unchanged provider failure. |
| `test/adapters/git-workspace-manager.test.ts` | no/read-only/branch workspace, reuse/conflict, cleanup | **D** `test-next/unit/execution/git-workspace.test.ts:17,44,76,107`, **E2E-EXEC-001**, and T16 prove normal lifecycle plus marker-owned crash recovery. |
| `test/adapters/prompt-templates.test.ts` | frontmatter validation, template rendering, maxTurns | **D** `test-next/e2e/scenarios/live-simple.test.ts:30` **E2E-PROMPT-001**, `doctor-diagnostics.test.ts:34,58`; **C** `ACT-AGENT-PROMPT` intentionally removes `allowAutoApproval` and default/clamp semantics. |
| `test/adapters/resource-index.test.ts` | correlation roles, reverse lookup, retraction, duplicate/replay | **D** T2/T10. |
| `test/adapters/runner-registry.test.ts` | runner registration, selection/fallback/capability | **D** `test-next/unit/execution/runner-selection.test.ts:18,66,115` and T8. |
| `test/adapters/runner-transcripts.test.ts` | enabled/disabled, prompt-first, retention/retrieval | **D** T14. |
| `test/adapters/self-update-ledger.test.ts` | idempotent update ledger/interruption | **D** `test-next/integration/bootstrap/update-maintenance-lease.test.ts` proves atomic persisted acquire/phase/failure/clear, failed-tag replacement, and dead-PID attempt-lock reclaim; `test-next/unit/bootstrap/self-update-application.test.ts` proves recovery and bad-candidate selection; **E2E-OPS-SELF-UPDATE-005/-006/-007** prove updating/rolling-back recovery, no repeated forward checkout, v2-bad/v3-new progression, and one concurrent owner. |
| `test/adapters/state-store.test.ts` | append ordering/CAS, streams, replay/persistence | **D** T10; **C** facade shape is consolidated by `PERSIST-JOURNAL`. |
| `test/adapters/ui-data.test.ts` | work/run/resource presentation and formatting | **C** `SURFACE-UI` deliberately corrects issue-shaped presentation into replaceable domain views; legacy formatting permutations are not a target compatibility contract. **D** T13 proves the domain-view composition, pagination/provenance, and board/analytics behaviour. |
| `test/adapters/ui-server.test.ts` | HTTP/static/UI routing/error responses | **C** `SURFACE-UI` deliberately replaces the legacy server shape. **D** T17 directly proves target SPA fallback, static-asset serving, API/static `404` boundaries, and static-method safety. |
| `test/bin/wake-dev.test.ts` | development launcher arguments/errors | **G-M8** no target dev-launcher behaviour or approved removal row. |
| `test/cli/audit-command.test.ts` | audit output/exit behaviour | **G-M9** no target audit command and no catalogue disposition. |
| `test/cli/build-runtime-pr-gating.test.ts` | runtime PR gate/approval restrictions | **D** T12; legacy build command shape is **C** under `ACT-PR-APPROVE`/`ACT-PR-MERGE`. |
| `test/cli/control-plane.test.ts` | tick/resident/wake/backoff/stop | **D** T11. |
| `test/cli/correlate-command.test.ts` | command validation/idempotency/retraction | **D** T2; text CLI parsing is **C** under `RESOURCE-CORRELATION`/`WORK-COMMAND`. |
| `test/cli/doctor-command.test.ts` | diagnostics/no mutation/rebuild | **D** T14. |
| `test/cli/init-command.test.ts` | create/refuse unsafe overwrite | **D** T14. |
| `test/cli/main.test.ts` | command parsing, help/version/exit | **D** T15 directly proves bare/help/version output without composition, pre-composition unknown/missing-command rejection, one operational dispatch with its JSON-line output, and positional/explicit `init` root precedence. The target assertion observes rejected command errors rather than spawning a process to assert its OS exit status, matching the legacy test's dispatch-level boundary. |
| `test/cli/sandbox-command.test.ts` | subcommands/build/up/stop/logs | **D** T14 routing; **G-M2** command construction and real process errors unproved. |
| `test/cli/sandbox-entrypoint-command.test.ts` | entrypoint safety/forwarding | **G-M2**. |
| `test/cli/sandbox-exec-logging.test.ts` | exec log capture/rotation | **G-M2**. |
| `test/cli/sandbox-resume.test.ts` | restart/resume status | **D** T14 routing; **G-M2** no composed resume assertion. |
| `test/cli/sandbox-setup-command.test.ts` | setup/install wiring | **G-M2**. |
| `test/cli/scaffold-assets.test.ts` | shipped asset creation/customization | **D** T14 initialise root; **G-M11** customized-asset preservation lacks direct target assertion. |
| `test/cli/self-update-command.test.ts` | source update/tag/recovery/container rebuild | **D** packaged refusal remains **E2E-OPS-SELF-UPDATE-001**; source-mode safe update is directly proven by **E2E-OPS-SELF-UPDATE-002/-003** (full maintenance pause, bounded drain/cancel, checkout only after empty active view), **-005/-006** (restart recovery), **-007** (exclusive owner/no duplicate forward checkout), and **-008** (completion racing cancellation write). |
| `test/cli/startup-preflight.test.ts` | configuration/auth/Docker diagnostic gate | **D** `doctor-diagnostics.test.ts:34,87,122,161,185`; `github-client-contract.test.ts` supplies the configured-token/`401` GitHub transport detail. |
| `test/cli/stop-command.test.ts` | stop/cancellation/graceful exit | **D** T7/T11. |
| `test/config/discover-config-files.test.ts` | glob/alphabetical/config.json discovery | **C** explicit removal: `ORCH-CONFIG-DISCOVERY`. |
| `test/config/load-config.test.ts` | load/validate/error layering | **D** `configured-workflow.test.ts:28` **E2E-CONFIG-001**; discovery compatibility is **C**. |
| `test/config/split-config.test.ts` | ownership-separated schema | **D** `configured-workflow.test.ts:28` **E2E-CONFIG-001**. |
| `test/core/approval-intents.test.ts` | intent authority/idempotency | **D** T12; comment-text authority is **C** under `ORCH-APPROVAL-AUTHORITY`. |
| `test/core/event-builders.test.ts` | event validation/identity | **D** T1/T10; provider-shaped event builders are **C** by `PERSIST-JOURNAL`. |
| `test/core/event-resolver.test.ts` | resolution/dedupe/source identity | **D** T1/T9. |
| `test/core/lifecycle-service.test.ts` | close/freeze/delete/completion | **D** `external-close-concludes-work.test.ts:13` **E2E-WORK-003** and lifecycle scenarios **E2E-LIFECYCLE-001/-002/-003/-005**; sentinel conflation is **C** `WORK-LIFECYCLE`. |
| `test/core/mint-qualification.test.ts` | eligibility/identity mint/reject | **D** T1 and `live-eligibility.test.ts:12` **E2E-LIVE-005**. |
| `test/core/outbox.test.ts` | durable effect, retries, unknown/accepted | **D** T4/T5. |
| `test/core/policy-engine.test.ts` | transitions/waits/signals/children/retries/loops | **D** **E2E-ORCH-WAIT-001**, **E2E-ORCH-CHILD-001**, **E2E-ORCH-RETRY-001**, **E2E-ORCH-LOOP-001**, and dark-factory IDs; legacy stage-on-work shape is **C**. |
| `test/core/projection-updater.test.ts` | fold/replay/checkpoint/idempotency | **D** T10/T5. |
| `test/core/quota-backoff.test.ts` | quota pause/backoff/expiry/resume | **D** T11 and `runner-pause-fallback.test.ts:27` **E2E-CONTROL-QUOTA-001**. |
| `test/core/run-lease.test.ts` | exclusive lease | **D** `test-next/unit/execution/lease.test.ts:17,52,89` plus T6/T7. |
| `test/core/scheduled-workflow-source.test.ts` | cron slot/once/restart/WIP | **D** T11; synthetic workflow source is **C** `CONTROL-SCHEDULE`. |
| `test/core/sink-router.test.ts` | route/sequence/error isolation | **C** `INT-DELIVERY-FANOUT` deliberately replaces generic multi-sink fanout with one durable intent for one Resource/provider. **D** `test-next/integration/integrations/delivery-service.test.ts` proves projection-order delivery and that a terminal failure on one provider/resource does not block the next intent; **E2E-FAULT-001** and **E2E-DUPLICATE-001** prove retry/ambiguity and effect idempotency. |
| `test/core/stale-run-reconciler.test.ts` | stale/missing/unknown run recovery | **D** T6/T5. |
| `test/core/tick-runner.approval.test.ts` | approval gate/trust/stale/retry | **D** T12. |
| `test/core/tick-runner.dispatch.test.ts` | claim/dispatch/cancel/budget | **D** T7/T11/T5. |
| `test/core/tick-runner.intake.test.ts` | intake/mint/dedupe/crash link | **D** T1/T5/T9. |
| `test/core/tick-runner.invariants.test.ts` | conflicts/invariants/no unsafe effect | **D** T3/T5/T12. |
| `test/core/tick-runner.outbox.test.ts` | delivery retries/restart | **D** T4/T5. |
| `test/core/tick-runner.quota.test.ts` | quota and fallback | **D** T11. |
| `test/core/tick-runner.reconcile.test.ts` | start-up reconciliation | **D** T6/T5. |
| `test/core/tick-runner.run-recording.test.ts` | claim-before-run/result once | **D** T5/T6 and `golden-path.test.ts:10` **E2E-GOLDEN-001**. |
| `test/core/tick-runner.test.ts` | transitions, watch/child, bounded cycles | **D** orchestration IDs above; special nested engine is **C** `ORCH-CHILD`/`ORCH-WATCH`. |
| `test/core/tick-runner.workspace-cleanup.test.ts` | cleanup after outcomes/transcript retention | **D** T14, target workspace unit tests, and T16: normal release/transcript retention stays separate from safe, marker-owned crash recovery. |
| `test/core/workspace-cleanup.test.ts` | cleanup semantics/errors | **D** target workspace units and T16: recovery continues after a cleanup error and never broadens deletion beyond a valid safe owner. |
| `test/domain/config-schema-split.test.ts` | owner config shape | **D** E2E-CONFIG-001. |
| `test/domain/event-types.test.ts` | event vocabulary/schema | **D** kernel event contract tests and T10; legacy types are **C** `PERSIST-JOURNAL`. |
| `test/domain/resource-uri.test.ts` | URI construction/parse/validation | **D** `test-next/unit/resources/resource-vocabulary.test.ts:9,35,71`; provider parsing is intentionally outside core (**C** `RESOURCE-IDENTITY`). |
| `test/domain/schema.test.ts` | global schema validation/defaults | **D** E2E-CONFIG-001 and prompt T14; legacy global shape/defaults are **C** `ORCH-CONFIG`. |
| `test/domain/workflows.test.ts` | workflow validation/routing | **D** E2E-CONFIG-001, **E2E-ORCH-RETRY-001**. |
| `test/domain/work-item-labels.test.ts` | Wake markers/labels | **C** target tags are intake-authored selectors (`ORCH-SELECTOR`); marker reconciliation deferred (`FUTURE-STATE-SYNC-EXTRACTION`). |
| `test/domain/work-item-status.test.ts` | status transitions/sentinels | **D** lifecycle IDs; status/stage/run conflation is **C** `WORK-LIFECYCLE`/`EXEC-RESULT`. |
| `test/lib/deep-merge.test.ts` | merge precedence/arrays | **D** E2E-CONFIG-001; multi-file discovery is **C** `ORCH-CONFIG-DISCOVERY`. |
| `test/lib/detached-process-logging.test.ts` | detached capture/exit/log path | **G-M13** no target detached-process logging proof. |
| `test/lib/format.test.ts` | elapsed/status/format rendering | **C** `SURFACE-UI` deliberately moves presentation to replaceable domain views; legacy elapsed/status formatting is not a target compatibility promise. T13 and T17 prove the target view and HTTP/asset boundaries. |
| `test/lib/lock.test.ts` | lock atomicity/stale PID/start identity | **D** `test-next/integration/persistence/file-lock.test.ts:19,45,74,105`; restart boundary T5/T10. |
| `test/lib/log-rotation.test.ts` | rotation/bounds/error handling | **G-M13**. |
| `test/lib/paths.test.ts` | Wake path layout | **C** target `.wake` layout is bootstrap-owned (`OPS-INIT`, `PERSIST-JOURNAL`); no byte/path compatibility promise. |
| `test/lib/work-id.test.ts` | ID generation/validation | **D** T1 and `test-next/unit/work/identifiers.test.ts:7,28,50`; derived external IDs are **C** `WORK-IDENTITY-MINTED`. |
| `test/lib/yaml-file.test.ts` | YAML parse/write/error | **D** E2E-CONFIG-001 and prompt diagnostics; write-helper compatibility is **C** config ownership. |
| `test/scripts/e2e-github-fake.test.ts` | runnable fake e2e script | **D** `github-fake-script.test.ts:5`; the real GitHub client contract suite supplies the separate transport proof. |
| `test/version.test.ts` | version source/format | **D** T18 proves the target resolver's exact-tag, source, Git-file, and development fallback contract and CLI publication boundary. |

## Findings and follow-up

Direct proof covers the high-risk domain behaviours: duplicate intake/effects,
conflicting or untrusted resources, exact-revision approval/merge, durable
delivery, journal/projection replay, cancellation/recovery, scheduling/quota,
and target operational scenarios.  The catalogue gives an explicit intentional
disposition for configuration discovery, legacy state/event shape, stage/status
sentinels, text authority, provider-shaped identities, and the deferred marker
reconciler.  Those are not gaps.

| Severity | Concrete gaps | Recommended follow-up |
| --- | --- | --- |
| Resolved | **G-M3/M4:** the target GitHub client suite now proves configured-token/`401` authentication, bounded paginated issue request plus conditional ETag read, exact merge/comment request mapping and provider-failure propagation, and redacted actual-Octokit `429`/`500` diagnostics with quiet `304`. | Evidence: `test-next/integration/integrations/github-client-contract.test.ts` and `github-client-request-logging.test.ts`. This is transport proof; it intentionally does not assert raw multi-page source ordering or legacy request-log ordering. |
| Resolved | **G-M10:** CLI main contract is directly proven. | Evidence: `test-next/integration/surfaces/cli-main-contract.test.ts` covers bare/help/version without composition, validation rejection before composition, operational dispatch/output, and `init` root resolution/precedence. Its command-error assertion is at the same dispatch boundary as legacy; neither suite spawns a process to assert an OS exit code. |
| Medium | **G-M1:** vendor runner unit proof does not cover Codex/Cursor output/error parsing; Claude coverage is partial. | Add table-driven tests to `process-execution.test.ts` for each runner’s success, malformed output, non-zero exit and timeout. |
| Resolved | **G-M2:** target fake-Docker integration proof now covers source/packaged command construction, configured mounts and resident setting, bounded Docker log options and streamed/scrubbed capture, plus setup forwarding and explicit resume forwarding/validation. | Evidence: `test-next/integration/surfaces/cli-infrastructure.test.ts`, `test-next/integration/surfaces/sandbox.test.ts`, `test-next/unit/surfaces/sandbox-setup.test.ts`, `test-next/unit/surfaces/sandbox-entrypoint.test.ts`, and `test-next/e2e/scenarios/sandbox-routing.test.ts`. This resolution does **not** claim the removed legacy sandbox UI/ngrok environment/tunnel contract or its zero-argument interactive resume picker: `OPS-SANDBOX-LEGACY-UI-TUNNEL` and `OPS-SANDBOX-INTERACTIVE-RESUME` record their approved removal and target replacements. **G-M6 is directly proven** by `test-next/integration/bootstrap/update-maintenance-lease.test.ts`, `test-next/unit/bootstrap/self-update-application.test.ts`, and `test-next/e2e/scenarios/self-update-maintenance.test.ts` scenarios **E2E-OPS-SELF-UPDATE-002/-003/-005/-006/-007/-008**: durable maintenance state, full pause and bounded drain/cancel, interrupted source recovery, bad-v2/new-v3 loop behaviour, exclusive attempt ownership, and cancellation-completion collision handling. |
| Resolved | **G-M5:** crash-orphan workspace recovery is directly proven without an unsafe general reaper. | T16 proves pre-clone durable ownership, terminal/absent-only reclamation, Started/Ambiguous/unknown/malformed/out-of-root retention, cleanup-error continuation, and idempotency. **E2E-EXEC-WORKSPACE-001/-003** prove a restarted composed root reclaims before dispatch; **-002** proves maintenance pauses the tick-driven sweep. There is deliberately no age timer, new configuration, or resident reaper. |
| Resolved | **G-M12:** legacy generic multi-sink fanout is deliberately consolidated, with direct target proof of ordered per-intent processing and failure isolation. | `INT-DELIVERY-FANOUT`; `test-next/integration/integrations/delivery-service.test.ts`; **E2E-FAULT-001** and **E2E-DUPLICATE-001**. |
| Resolved | **G-M7:** legacy UI formatting and server shape have the approved `SURFACE-UI` correction, while target HTTP/static asset behaviour is directly proven. | T13 proves target domain-view composition; T17 proves SPA fallback, static asset serving, and API/static routing boundaries. The resolution does not claim legacy formatting-string compatibility. |
| Resolved | **G-M14:** target version resolution and CLI publication are directly proven. | T18 proves exact tag, source, Git-file and development fallbacks plus both CLI version aliases. |
| Low | **G-M8/M9/M13:** dev launcher/audit, detached process logging, and rotation have no intentional disposition or direct proof. | Decide per capability: add small target contract tests, or document removal/defer in the catalogue. |

## Verification

Run after writing this review:

```text
npm run check:catalogue
npm run check:scenarios
```

The report makes no assertion that either command verifies this report; they
verify the catalogue and the registered target scenario linkage on which this
review relies.

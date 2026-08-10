# Rewrite Completion Audit

This is an evidence record for Task 27, not a claim that the legacy and target
internals are equivalent. Results below are from the commands in the **Verification**
column on 2026-08-10. The accepted comparison surface is public lifecycle,
external effects, selected Activity, workspace mode, and operator output only.

## Accepted differential checks for `preserve` decisions

| Catalogue ID | Direct result or non-comparability rationale | Target proof |
| --- | --- | --- |
| WORK-COMMAND | Non-comparable: legacy accepts provider-comment command text; target accepts typed public commands and deliberately rejects text outside a typed signal context. Comparing internal command events/status would violate the accepted surface. | `E2E-ORCH-COMMAND-001`, `supplemental-command.test.ts` |
| RESOURCE-CORRELATION | Comparable public outcome: repeated high-level correlation leaves one active relation and one WorkItem outcome; target scenario passes. Legacy and target use different minted identities, so IDs/events were not compared. | `E2E-WORK-001`, `work-resource-correlation.test.ts` |
| EXEC-WORKSPACE | Non-comparable: legacy fake provisions Git paths and target fake exposes declared workspace capability/cleanup; file paths are expressly excluded. Target proves the allowed `none` mode and workspace lifecycle. | `E2E-EXEC-001`, `golden-path.test.ts`; `test-next/unit/execution/git-workspace.test.ts` |
| CONTROL-QUOTA | Comparable allowed outcome: unavailable runner pauses dispatch and alternate/eligible work remains selectable; target scenario passes. Reset timestamps and runner-health records are not compared. | `E2E-CONTROL-003`, `quota-pause.test.ts` |
| SURFACE-CLI | Non-comparable: the legacy CLI is a process parser with legacy state/adapters, whereas the target E2E exercises API-domain output and injected surface applications. Help text or legacy status shape is excluded. | `E2E-SURFACE-001`, `api-domain-shape.test.ts` |
| OPS-INIT | Comparable operator outcome: initialization produces a usable Wake root and refuses unsafe overwrite; target scenario passes. Scaffold bytes differ by target configuration design and were not compared. | `E2E-OPS-INIT-001`, `initialise-root.test.ts` |
| OPS-DOCTOR | Comparable operator outcome: diagnostics distinguish usable/notices/failures and rebuild leaves canonical data intact; target scenario passes. Provider probe implementation is intentionally different. | `E2E-OPS-001`, `doctor-rebuild.test.ts` |
| OPS-SANDBOX | Non-comparable without Docker/process side effects: fakes expose different process ports, and generated Dockerfiles/log paths are excluded. Target command routing and bounded lifecycle are directly tested. | `E2E-OPS-SANDBOX-001`, `sandbox-routing.test.ts` |
| OPS-SELF-UPDATE | Non-comparable without a real source checkout/tag remote: legacy and target update ledgers differ and filesystem internals are excluded. Target proves its supported packaged-mode operator refusal. | `E2E-OPS-SELF-UPDATE-001`, `self-update-packaged.test.ts` |
| OPS-TRANSCRIPT | Comparable operator outcome: enabled transcript remains readable after workspace cleanup and disabled capture has no transcript; target scenario passes. Session/file identity is excluded. | `E2E-OPS-TRANSCRIPT-001`, `transcript-retention.test.ts` |

The paired legacy evidence command passed 9 files / 71 tests:
`npm test -- test/core/approval-intents.test.ts test/cli/correlate-command.test.ts test/core/quota-backoff.test.ts test/bin/wake-dev.test.ts test/cli/init-command.test.ts test/cli/doctor-command.test.ts test/cli/sandbox-command.test.ts test/cli/self-update-command.test.ts test/adapters/runner-transcripts.test.ts`.
The focused target command passed 10 files / 19 tests:
`npx vitest run --config vitest.next.e2e.config.ts` with the ten scenario files named above.

## Design-section evidence

| Design section and requirement | Implementing files | Proving tests/scenarios | Verification | Result |
| --- | --- | --- | --- | --- |
| 1. Executive decision — target modules replace legacy architecture alongside it. | `src-next/main.ts`, `src-next/bootstrap/composition-root.ts`, `scripts/check-module-manifests.mjs` | `test-next/architecture/module-manifests.test.ts`, `E2E-GOLDEN-001` | `npm run lint:architecture`; `npm run test:next:e2e` | PARTIAL — E2E passes; architecture gate has the Section 6 violation. |
| 2. Goals — deterministic, safe, observable progress. | `src-next/control-plane/application/advance-once.ts`, `src-next/surfaces/api/routes.ts` | `E2E-GOLDEN-001`, `E2E-SURFACE-001`, `E2E-CONTROL-001` | `npm run test:next:e2e` | PASS |
| 3. Principles — typed ownership, explicit effects, no hidden authority. | `src-next/kernel/contracts`, `src-next/activities`, `src-next/orchestration` | `E2E-SECURITY-001`, `E2E-DELIVERY-001` | `npm run lint:architecture`; `npm run test:next:e2e` | PARTIAL — E2E passes; architecture gate has the Section 6 violation. |
| 4. Legacy evidence authority — catalogue retains every frozen evidence path. | `docs/architecture/functional-decision-catalogue.md`, `scripts/check-functional-catalogue.mjs` | catalogue checker | `npm run check:catalogue` | PASS — 61 decisions |
| 5. Foundational model — minted WorkItem/Resource identities and typed relations. | `src-next/work`, `src-next/resources`, `src-next/kernel/contracts/identifiers.ts` | `E2E-WORK-001`, `E2E-WORK-002`, `E2E-LIVE-009` | `npm run test:next:e2e` | PASS |
| 6. Contexts — declared module boundaries and dependency direction. | `src-next/*/MODULE.md`, `src-next/*/module.json`, `dependency-cruiser.config.mjs` | `test-next/architecture/module-manifests.test.ts`; dependency-cruiser | `npm run lint:architecture` | PASS — manifests, contract vocabulary, and dependency-cruiser pass for 399 modules with no violations. |
| 7. Orchestration — validated workflow routing, waits, children, and bounded repeats. | `src-next/orchestration/application`, `src-next/orchestration/domain` | `E2E-ORCH-WAIT-001`, `E2E-ORCH-CHILD-001`, `E2E-ORCH-RETRY-001`, `E2E-ORCH-LOOP-001` | `npm run test:next:e2e` | PASS |
| 8. Activities — typed inputs/outcomes, PR authority, and prompt validation. | `src-next/activities/contracts`, `src-next/activities/agent`, `src-next/activities/pr` | `E2E-PROMPT-001`, `E2E-PR-APPROVE-001`, `E2E-PR-MERGE-001` | `npm run test:next:e2e` | PASS |
| 9. Execution — Runs, leases, cancellation, recovery, runners, and optional workspace. | `src-next/execution/application`, `src-next/execution/contracts` | `E2E-EXEC-001`, `E2E-EXEC-CANCEL-001`, `E2E-EXEC-RECOVER-001` | `npm run test:next:e2e` | PASS |
| 10. Events/persistence/delivery — journal replay, replaceable projections, durable outbox. | `src-next/persistence`, `src-next/integrations/application`, `src-next/bootstrap/projection-runtime.ts` | `E2E-JOURNAL-001`, `E2E-PROJECTION-001`, `E2E-DELIVERY-001`, `E2E-FAULT-001` | `npm run test:next:e2e` | PASS |
| 11. Hosts — equivalent tick/resident advancement, schedules, fairness, quota. | `src-next/control-plane`, `src-next/control-plane/infrastructure/{tick-host,resident-host}.ts` | `E2E-CONTROL-001`, `E2E-CONTROL-002`, `E2E-CONTROL-003`, `E2E-SCHEDULE-001` | `npm run test:next:e2e` | PASS |
| 12. Configuration/API ownership — fixed config loading and loopback domain API. | `src-next/bootstrap/config/load-config.ts`, `src-next/surfaces/api` | `E2E-CONFIG-001`, `E2E-SURFACE-001`, `E2E-SURFACE-BOARD-001` | `npm run test:next:e2e` | PASS |
| 13. Module specifications — source-adjacent normative specs cover each target module. | `src-next/SPECIFICATION.md`, `src-next/*/SPEC.md`, `scripts/check-specs.mjs` | specification checker | `npm run check:specs` | PARTIAL — `check:specs` reports `activities`, `bootstrap`, and `execution` stale against their recorded commit; this status remains until the relevant changes are committed and is separate from the passing architecture check. |
| 14. Guardrails — catalogue, contracts, manifests, and dependency rules are executable. | `scripts/check-functional-catalogue.mjs`, `scripts/check-scenario-coverage.mjs`, `scripts/check-contract-vocabulary.mjs` | checker E2E plus architecture tests | `npm run check:catalogue`; `npm run check:scenarios`; `npm run lint:architecture` | PASS — catalogue, scenario, manifest, vocabulary, and dependency checks pass; the separate `check:specs` stale-until-commit status is recorded in Section 13. |
| 15. Testing strategy — deterministic fakes, fault matrix, duplicates, and security boundaries. | `test-next/e2e/support/world.ts`, `test-next/e2e/support/faults.ts`, `test-next/e2e/scenarios/fault-matrix.test.ts` | `E2E-FAULT-001`, `E2E-DUPLICATE-001`, `E2E-SECURITY-001` | `npm run test:next:e2e` | PASS |
| 16. Functional catalogue — every retained decision names a target scenario; remove/defer rows state a reason. | `docs/architecture/functional-decision-catalogue.md` | catalogue and scenario checkers | `npm run check:catalogue`; `npm run check:scenarios` | PASS — 52 scenario IDs |
| 17. Replacement method — no dual-write/migration compatibility layer. | `src-next`, `docs/adrs/0001-correlating-external-resources-to-work-items.md` | `E2E-JOURNAL-001`, architecture checks | `npm run lint:architecture`; `npm run test:next:e2e` | PASS — E2E and architecture checks pass; `check:specs` is tracked separately in Section 13. |
| 18. Immediate priorities — control-plane, safety, and operational surfaces are exercised end-to-end. | `src-next/control-plane`, `src-next/surfaces`, `src-next/bootstrap` | `E2E-CONTROL-002`, `E2E-OPS-001`, `E2E-SURFACE-001` | `npm run test:next:e2e` | PASS |
| 19. Existing issues/advisory material — approved decisions are tracked rather than silently imported. | `docs/architecture/functional-decision-catalogue.md`, `docs/reports/2026-08-02-target-architecture-spec-findings.md` | catalogue checker | `npm run check:catalogue` | PASS |
| 20. Success criteria — target scenario coverage, maintainability checks, and public outcomes have evidence. | this audit; `scripts/check-scenario-coverage.mjs`; `test-next/e2e/scenarios` | all scenario IDs above | `npm run check:catalogue`; `npm run check:scenarios`; `npm run lint:architecture`; `npm run test:next:e2e` | PARTIAL — scenario gates, 49-file/88-test E2E, and architecture checks pass; only the separate `check:specs` stale-until-commit status in Section 13 remains open. |

## Deferred capabilities

The following remain intentionally unimplemented and are not counted as tested
target features: state-sync extraction (`FUTURE-STATE-SYNC-EXTRACTION`),
snapshots (`FUTURE-SNAPSHOT`), event upcasting (`FUTURE-EVENT-UPCASTING`),
workflow versioning (`FUTURE-WORKFLOW-VERSIONING`), work dependency policy
(`FUTURE-WORK-DEPENDENCY-POLICY`), parallel positions
(`FUTURE-PARALLEL-POSITIONS`), workflow transfer (`FUTURE-WORKFLOW-TRANSFER`),
communication/document Activities (`FUTURE-COMMUNICATION-DOCUMENT-ACTIVITIES`),
and database persistence (`FUTURE-DATABASE-ADAPTER`).

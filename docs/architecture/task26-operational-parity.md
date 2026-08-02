# Task 26 Operational Parity and Adaptation Checklist

This is an evidence catalogue, not a completion declaration. A `complete` row has direct target behaviour and proof; `partial` means useful target behaviour exists but the legacy contract has remaining applicable facets.

| Capability | Legacy behaviour evidence | Target adaptation and proof | Status |
| --- | --- | --- | --- |
| Init root/assets | `test/cli/init-command.test.ts`, `test/cli/scaffold-assets.test.ts` | Bootstrap init creates visible config/workflow/prompt/setup/Dockerfile assets plus required `.wake` roots (including logs); main deliberately executes it before composition. | partial |
| Doctor diagnostics | `test/cli/doctor-command.test.ts`, `test/cli/startup-preflight.test.ts` | Checks runner-pool resolution, provider identity, visible config/workflow/prompt assets, accessible runtime roots, canonical journal, checkpoints, and all projections. | partial |
| Doctor rebuild safety | Task 26 E2E requirement | `doctor-rebuild.test.ts` corrupts a disposable projection, rebuilds the public Work view, and proves the canonical journal bytes are unchanged. | complete |
| Runner smoke | legacy smoke command surface | Target smoke resolves the configured `RunnerRegistry` pool and reports `RunnerResult.transport`. | complete |
| Docker lifecycle | `test/adapters/docker-cli.test.ts`, sandbox tests | Target injected boundary builds, checks image availability, makes `up` idempotent (running/stopped/missing), recreates safely on update, applies a 60-second stop grace, and consumes validated `host.sandbox` image/container/mount/start settings. | partial |
| Process logs/secrecy | `test/lib/detached-process-logging.test.ts`, sandbox exec tests | Target sink scrubs assignment and credential-shaped secrets before caller output and durable logs; it also rotates at a configured byte limit. | partial |
| Stop drain | `test/cli/stop-command.test.ts` | Target stop polls the Execution projection until no started runs remain before closing hosts. | complete |
| Self-update safety | `test/cli/self-update-command.test.ts`, ledger tests | Source-local process port discovers tags and verifies state; application refuses dirty trees, records pending updates, restores interrupted changes, skips known bad tags, rolls back failed health, and only advances the durable ledger after health. Source updates are allowed only by `host.development.mode: source`. | partial |
| Fake GitHub E2E | `test/scripts/e2e-github-fake.test.ts` | `scripts-next/e2e-github-fake.ts` composes target main/Bootstrap in a temp root, verifies `.wake` data, and rejects legacy state; package scripts explicitly distinguish target and legacy. | complete |
| CLI reachability | `test/cli/main.test.ts`, Task 26 directive | Target parser routes init, doctor, sandbox, self-update, and smoke; `init` is intentionally pre-composition. | complete |

## Still required before Task 26 can be declared complete

- Compare init assets against every retained source/packaged scaffold policy and validate semantic config/prompt content, not just their presence.
- Finish doctor preflight policy: configuration/prompt validation, provider connectivity, and an explicit Docker-health policy that works for target deployments without treating Docker absence as canonical-state failure.
- Decide and implement target equivalents for sandbox setup, resume, interactive exec/UI forwarding, configurable mounts, live captured process output, and bounded container log policy; explicitly mark any no-longer-applicable legacy feature with architectural rationale.
- Add a bad-tag policy and production health checks beyond `git rev-parse` for self-update.
- Add target scenarios for operational process/Docker composition (not just adapter fakes), then rerun the exact final gates before any commit or merge.
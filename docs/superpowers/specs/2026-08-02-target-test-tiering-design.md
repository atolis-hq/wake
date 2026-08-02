# Target Test Tiering Design

## Purpose

Make target-architecture test cost and scope explicit. Routine local validation must run only unit tests. Integration and end-to-end suites run only through their named commands or the aggregate CI gate.

## Test layout and ownership

`test-next/` has three physical, exclusive tiers:

```text
test-next/
  unit/
  integration/
  e2e/
```

- **Unit** tests one module or application policy using in-memory ports, fakes, or pure values. It does not create a Wake home, invoke the composed CLI/runtime, or depend on a real filesystem/process boundary.
- **Integration** tests a bounded adapter or a real local boundary such as the filesystem-backed journal, projection store, lock, child process, or web server. It may use temporary storage, but does not compose and drive a complete Wake runtime scenario.
- **E2E** drives composed Wake behaviour through its real surface/runtime boundary. `ProcessWorld`, CLI commands over a composed root, persistent projection recovery, and multi-module workflow scenarios belong here. External live-provider cases remain an explicit subset of this tier.

A test belongs in exactly one tier. Directory location is the source of truth; no runner contains a hand-maintained file allowlist.

## Commands

The package exposes exactly these target commands:

| Command | Scope | Normal use |
| --- | --- | --- |
| `test:next` / `test:next:unit` | `test-next/unit/**` | routine local feedback |
| `test:next:integration` | `test-next/integration/**` | explicit local boundary validation |
| `test:next:e2e` | `test-next/e2e/**` | explicit composed-runtime validation |
| `verify:next` | target static checks, web component tests, target unit tests | routine target verification |
| `verify:ci` | legacy verification plus all three target tiers | CI only / intentional full validation |

Each tier has a dedicated Vitest config with an exclusive directory `include`. The E2E config serializes files by default because its scenarios create and recursively remove real temporary Wake homes. The live-provider scenarios stay an explicit opt-in command if they require credentials or other external setup; they are never folded into routine E2E or CI implicitly.

## Migration and guardrails

Existing files are physically moved without changing their test behaviour. Classify based on the boundary exercised, not their current module name. Update imports mechanically after each move.

A small script-contract test reads `package.json` and the three Vitest configs to prove that the tier commands and their directory ownership do not overlap, that `verify:next` invokes only the unit tier, and that `verify:ci` invokes integration and E2E explicitly. This prevents the previous accidental broad `test-next/**` include from returning.

## CI

The existing CI workflow continues to execute `npm run verify:ci`. Its aggregate command, rather than `verify:next`, owns full target integration and E2E coverage. Pull requests therefore retain complete validation while normal local `verify:next` stays fast and does not contend on filesystem-heavy E2E fixtures.
## Amendment: architecture tier (2026-08-02)

Architecture tests are a fourth physical tier, `test-next/architecture/**`, not integration tests. They invoke repository-wide structural and governance tooling (ESLint, module-manifest, vocabulary, and build-lane checks), but the corrected suite completes quickly and therefore runs alongside unit tests in routine validation.

The authoritative commands are:

| Command | Scope |
| --- | --- |
| `test:next` / `test:next:unit` | `test-next/unit/**` |
| `test:next:architecture` | `test-next/architecture/**` |
| `test:next:integration` | `test-next/integration/**` |
| `test:next:e2e` | non-live `test-next/e2e/**`, serially |
| `test:next:e2e:live` | explicit live-provider subset only |
| `verify:next` | unit plus architecture, never integration or E2E |
| `verify:ci` | all four non-live tiers |

This amendment supersedes the earlier three-tier wording. The architecture config is an explicit CI path-filter input.

## Amendment: local finishing gate (2026-08-03)

`verify:local` is the single local finishing gate. It runs `verify` and `verify:next`, covering both legacy and target static checks, builds, unit tests, web component tests, and target architecture tests. It deliberately excludes legacy integration, target integration, non-live E2E, and live-provider E2E.

`verify:ci` remains the GitHub CI aggregate. It runs `verify:local` and explicitly adds every non-live integration and E2E tier. Local development and branch completion do not require `verify:ci`; CI is the full-system protection layer for edge cases and real-boundary coverage.

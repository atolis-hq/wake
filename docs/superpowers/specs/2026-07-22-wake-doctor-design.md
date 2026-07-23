# wake doctor: design

- Date: 2026-07-22
- Status: proposed
- Implements: findings #8 and #14 of `SETUP-REPORT.md` ("Group D")
- Depends on: [git-style .wake/ restructure design](2026-07-22-wake-home-restructure-design.md) — built after that lands, so checks report against the new layout without needing dual-layout detection logic
- Related: [dev.mode design](2026-07-22-dev-mode-packaged-builds-design.md) — version staleness check execs `wake version` inside the container, which works identically for both dev.mode variants

## Purpose

There's a preflight check (`src/cli/startup-preflight.ts`), but it's narrower than a general completeness check: it only runs as part of `wake start`, not standalone; it checks prompt templates and (only for runners actively referenced by a non-`"fake"` tier/workflow) that the runner CLI is invocable, plus canonical clone health if GitHub source is enabled with repos configured. It does not check GitHub token resolvability (`resolveGitHubToken()` shells to `gh auth token` and only fails at actual runtime), Docker/sandbox reachability, or anything about version drift. There is no standalone `wake doctor`/`wake config check` command — the only way to exercise even the existing checks is to run `wake start` and wait for it to either pass silently or throw.

A fully valid, schema-conforming config with every tier routed to `"fake"` and GitHub disabled passes preflight trivially, because nothing real is wired up — not because anything has been verified. This is fine for the fake-adapter test harness use case but gives no confidence signal for a real setup.

## Design

### Command: `wake doctor`

Single canonical name (the report's "wake config check" was an alternate phrasing for the same command, not a second one — avoids two names for one thing). Runs on demand, standalone, non-mutating — no state written, no sandbox started, no agent runs triggered.

### Extracted + reused: existing preflight checks

`runStartupPreflight`'s existing logic (prompt template readability for every action/mode combination referenced by configured workflows; for each runner actually referenced by an active tier or workflow stage whose `kind` isn't `"fake"`, that the runner CLI responds to `--version`; canonical clone health for each configured GitHub repo when a real runner is active and GitHub source is enabled) is exposed as a function `wake doctor` calls directly, rather than duplicated. `wake start`'s own preflight-before-starting behavior is unchanged — `wake doctor` is additive, not a replacement; the two share the same underlying check function.

### New checks

1. **GitHub token resolvability.** Call `resolveGitHubToken()` (`src/adapters/github/github-auth.ts`) whenever `sources.github.enabled` is `true`, independent of whether a real (non-fake) runner is also active — today this path is only exercised by an actual runtime failure, never proactively.
2. **Docker/sandbox reachability.** When `docker/Dockerfile` exists at the resolved wake-root (the same signal Group C's CLI-folded auto-delegation uses to decide whether to route into the sandbox), check the Docker daemon responds and the configured `sandbox.image`/`sandbox.containerName` are inspectable (reusing the existing `inspectDockerImage`/`inspectDockerContainer` adapters already wired into `main.ts`'s sandbox path).
3. **Version and drift staleness** (finding #14). Two independent sub-checks, both informational (never fail the overall exit code — see Output below):
   - **Sandbox version vs. installed CLI**: if the sandbox container is running, `docker exec <containerName> node /app/dist/src/main.js version` (or, for a packaged-mode image, the equivalent installed `wake version`) is compared against the host's own `wakeVersion` (`src/version.ts`). A mismatch is reported, not auto-fixed — the fix is the existing `wake sandbox build && wake sandbox update` (or `self-update` in `dev.mode: "source"`).
   - **Prompt/Dockerfile drift**: diff `wake-home/prompts/*.md` and `wake-home/docker/Dockerfile` against the currently-shipped defaults bundled with the installed CLI. Report only which files differ from the shipped default — **never auto-overwrite** these files, since both are explicitly user-owned and expected to be customized (matches finding #14's constraint directly). This surfaces silent drift (e.g. a newer version feeds a prompt template a new Handlebars variable that an old customized template doesn't use — nothing breaks, but nothing currently signals it either) without taking any destructive action.

### Output and exit code

A flat list of check results, reusing `runStartupPreflight`'s `failures: string[]` accumulation shape: each of the existing preflight checks and the two new hard checks (GitHub token, Docker/sandbox reachability) can fail and contributes to a non-zero exit code. The two staleness/drift checks are informational-only — printed as a separate "notices" section, never contribute to exit code, since neither represents a broken setup, just a heads-up.

## Out of scope

- Any schema-version migration mechanism for `.wake/` data files — noted in the report as a future concern once `domain/schema.ts`'s hardcoded `schemaVersion: z.literal(1)` needs to move, not a live problem today.
- Auto-remediation of any kind (auto-rebuilding the sandbox, auto-updating prompts) — `wake doctor` reports, it never mutates.

## Testing

- Existing `startup-preflight.test.ts` fixtures are reused for the shared check logic (extracted, not rewritten) to confirm `wake doctor` and `wake start`'s preflight produce consistent results from the same inputs.
- New cases: GitHub token resolution failure surfaces as a `wake doctor` failure when `sources.github.enabled` is true and no real runner is active (the gap `runStartupPreflight` has today); Docker daemon unreachable surfaces as a failure only when `docker/Dockerfile` is present; version mismatch and prompt/Dockerfile drift both surface as informational notices without affecting exit code.

## Documentation

README gets a `wake doctor` entry in the command list introduced by Group A's `--help` output, plus a short "diagnosing setup problems" pointer near the "Getting Started" section pointing new users at `wake doctor` as the first thing to run after `wake init` and `wake sandbox build`.

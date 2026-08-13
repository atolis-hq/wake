# CI Repair and Migration-Name Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the PR's CI checks and remove obsolete active `-next` migration identifiers.

**Architecture:** Keep runtime behaviour unchanged except for Docker smoke: the workflow creates a valid Wake root before invoking `tick`. Tests record the current generated-Docker build command and smoke-root setup. Historical migration documentation remains unchanged.

**Tech Stack:** GitHub Actions YAML, Node.js, TypeScript, Vitest, Docker.

---

### Task 1: Correct the launcher security expectation

**Files:**
- Modify: `test/integration/surfaces/wake-dev-next.test.ts`

- [ ] Replace the false shell-injection assertion with one that permits literal command text but rejects a separate output line.
- [ ] Run `npx vitest run test/integration/surfaces/wake-dev-next.test.ts`.
- [ ] Rename the file to `test/integration/surfaces/wake-dev.test.ts` and rerun it.

### Task 2: Test and repair the current build and smoke contracts

**Files:**
- Modify: `test/integration/bootstrap/initialise.test.ts`
- Modify: `test/architecture/build-lane.test.ts`
- Modify: `src/bootstrap/initialise.ts`
- Modify: `.github/workflows/ci-cd.yml`

- [ ] Make the tests require `npm run build:docker` in the generated Dockerfile and an `init` command before the CI `tick` command.
- [ ] Run `npx vitest run test/integration/bootstrap/initialise.test.ts test/architecture/build-lane.test.ts` and confirm it fails.
- [ ] Change the generated Dockerfile to `build:docker`; run `init` then `tick` in one Docker smoke invocation.
- [ ] Rerun the focused tests.

### Task 3: Remove active migration-era identifiers

**Files:**
- Modify: `.gitignore`, `.dockerignore`, `.prettierignore`, `dependency-cruiser.config.mjs`
- Modify: `bin/package.json`, `scripts/seed-fake-scenario-issues.ps1`

- [ ] Remove `dist-next` ignores/exclusions.
- [ ] Rename active `wake-next` operational labels and configuration comments to `wake`.
- [ ] Change the development-bin metadata from `source-next` to `source`.
- [ ] Verify no migration identifiers remain outside historical docs: `rg -n --glob '!docs/**' --glob '!archive/**' --glob '!node_modules/**' --glob '!.worktrees/**' 'src-next|test-next|dist-next|wake-dev-next|wake-next|build:next' .`.

### Task 4: Verify and publish

- [ ] Run `npm run verify`, `npm run knip`, and `npm run test:web`.
- [ ] Commit the repair and push it to PR #530.
- [ ] Confirm the PR's test and Docker-smoke checks pass.

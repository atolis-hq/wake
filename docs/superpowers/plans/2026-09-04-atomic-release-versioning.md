# Atomic Release Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare all public workspace versions atomically so release publication does not resolve an unpublished internal package.

**Architecture:** Use manifest-only `npm pkg set` commands for Eventing, Eventing filesystem, and Wake. Regenerate the lockfile after all exact versions agree, then publish in existing dependency order.

**Tech Stack:** GitHub Actions YAML, npm workspaces, Vitest.

---

### Task 1: Release preparation

**Files:**

- Modify: `.github/workflows/ci-cd.yml:202-211`
- Modify: `test/architecture/release-packaging.test.ts:48-70`

- [ ] Write a failing architecture assertion that requires `npm pkg set version="$WAKE_VERSION"` for each public workspace and rejects `npm version "$WAKE_VERSION"`.
- [ ] Run `npx vitest run test/architecture/release-packaging.test.ts` and confirm it fails because the workflow uses `npm version`.
- [ ] Replace the three `npm version` commands with these manifest-only commands:

```bash
npm --workspace @atolis-hq/eventing pkg set version="$WAKE_VERSION"
npm --workspace @atolis-hq/eventing-filesystem pkg set version="$WAKE_VERSION" dependencies.@atolis-hq/eventing="$WAKE_VERSION"
npm pkg set version="$WAKE_VERSION" dependencies.@atolis-hq/eventing="$WAKE_VERSION" dependencies.@atolis-hq/eventing-filesystem="$WAKE_VERSION"
```

- [ ] Keep the one following `npm install --package-lock-only --ignore-scripts` and existing publication order.
- [ ] Run `npx vitest run test/architecture/release-packaging.test.ts`, `npm run test:architecture`, and `npm run check:workspace-packages`.
- [ ] Commit the workflow, test, design, and plan with `fix: prepare release versions atomically`.

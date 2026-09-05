# Embedded Eventing Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Eventing runtime code inside the single published Wake archive while retaining separate workspace builds and tests.

**Architecture:** A build script copies each compiled workspace package and its manifest into Wake's `dist/src/node_modules/@atolis-hq`. Node resolves those embedded packages from the installed Wake entrypoint. Release and archive checks package only Wake and validate a clean install plus an offline CLI invocation.

**Tech Stack:** npm workspaces, Node filesystem APIs, GitHub Actions, Vitest.

---

### Task 1: Prove and implement embedded runtime packaging

**Files:**

- Create: `scripts/embed-runtime-workspaces.mjs`
- Modify: `package.json`
- Modify: `packages/eventing/package.json`
- Modify: `packages/eventing-filesystem/package.json`
- Modify: `scripts/check-workspace-packages.mjs`
- Test: `test/architecture/workspace-packages.test.ts`

- [ ] Add failing architecture tests requiring Eventing manifests to be private, requiring Wake to omit registry dependencies, requiring the embed script in the Wake build, and requiring archive verification to pack and install Wake only.
- [ ] Run `npx vitest run test/architecture/workspace-packages.test.ts` and confirm the old public-package contract fails.
- [ ] Add the embedding script to copy both built workspace packages into `dist/src/node_modules/@atolis-hq`, after removing any previous embedded directory.
- [ ] Mark Eventing manifests private, remove their public publishing metadata, remove both registry dependencies from Wake, and invoke the embedding script after TypeScript builds.
- [ ] Rewrite the package archive checker to pack only Wake, install only that archive in a temporary project, verify both embedded runtime package directories, and execute the installed CLI offline.
- [ ] Run the focused architecture test, `npm run check:workspace-packages`, and `npm run build`.

### Task 2: Publish one package

**Files:**

- Modify: `.github/workflows/ci-cd.yml`
- Test: `test/architecture/release-packaging.test.ts`

- [ ] Add a failing release-packaging test requiring the release workflow to set and publish only Wake, and rejecting Eventing publish commands.
- [ ] Run `npx vitest run test/architecture/release-packaging.test.ts` and confirm it fails against the multi-package release job.
- [ ] Replace the workspace version preparation and three publish steps with one Wake version update and one Wake publish step; keep provenance and package verification.
- [ ] Run the focused release test, `npm run test:architecture`, and `npm run verify`.
- [ ] Commit the implementation, design, and plan records.

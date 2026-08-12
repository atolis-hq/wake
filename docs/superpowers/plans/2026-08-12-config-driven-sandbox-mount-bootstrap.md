# Config-Driven Sandbox Mount Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent configured nested credential mounts from blocking sandbox-owned runtime state such as GitHub CLI authentication.

**Architecture:** Derive parent directories from configured extra-mount targets below the configured sandbox home. Pass those paths to a root-only image bootstrap wrapper, which creates and owns them before dropping to the `wake` user and starting the existing entrypoint.

**Tech Stack:** TypeScript, Vitest, generated Dockerfiles, Docker bind mounts.

---

### Task 1: Derive and pass mount-parent paths

**Files:**
- Modify: `src/surfaces/cli/infrastructure/docker-cli.ts`
- Test: `test/integration/surfaces/cli-infrastructure.test.ts`

- [ ] **Step 1: Write failing tests**

Add a container-creation case with targets `/home/wake/.config/cursor/auth.json`, `/home/wake/.codex/auth.json`, and `/other/auth.json`. Assert the `docker run` command contains one `WAKE_HOME_INIT_DIRS` value with `/home/wake/.config`, `/home/wake/.config/cursor`, and `/home/wake/.codex`, but no `/other` path.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npx vitest run test/integration/surfaces/cli-infrastructure.test.ts`

Expected: FAIL because container creation does not currently emit `WAKE_HOME_INIT_DIRS`.

- [ ] **Step 3: Implement derivation**

Implement a local helper that takes `containerHomeMountPath` and `extraMounts`, collects every strict parent between the home and each nested target, and returns sorted unique paths. Add `-e WAKE_HOME_INIT_DIRS=...` only when that result is non-empty.

- [ ] **Step 4: Re-run the focused test**

Run: `npx vitest run test/integration/surfaces/cli-infrastructure.test.ts`

Expected: PASS.

### Task 2: Bootstrap before the resident process

**Files:**
- Modify: `src/bootstrap/initialise.ts`
- Test: `test/integration/bootstrap/initialise.test.ts`

- Modify: `C:\\Users\\live\\wake-home\\docker\\Dockerfile` via `wake sandbox build`

- [ ] **Step 1: Write failing generated-Dockerfile assertions**

Assert both initialized Dockerfile variants contain the mount-bootstrap loop, validate paths against `/home/wake`, create directories, `chown wake:wake` only on those directories, and exec the existing Wake entrypoint as `wake`.

- [ ] **Step 2: Run the initializer test and confirm it fails**

Run: `npx vitest run test/integration/bootstrap/initialise.test.ts`

Expected: FAIL because generated Dockerfiles currently run directly as `wake`.

- [ ] **Step 3: Implement the wrapper in both templates**

Make the generated image retain root only for bootstrap. Parse the newline-delimited `WAKE_HOME_INIT_DIRS`, reject non-home paths, `mkdir -p` and `chown wake:wake` each derived directory, then use `su - wake` to exec the existing source or packaged sandbox entrypoint.

- [ ] **Step 4: Re-run the initializer test**

Run: `npx vitest run test/integration/bootstrap/initialise.test.ts`

Expected: PASS.

### Task 3: Verify and repair the production sandbox

**Files:**
- Generated: `C:\\Users\\live\\wake-home\\docker\\Dockerfile`

- [ ] **Step 1: Run focused source verification**

Run: `npm run lint -- --quiet` and the two focused Vitest files.

- [ ] **Step 2: Build and recreate the sandbox**

Run: `wake-dev sandbox build`, then `wake-dev sandbox update` from `C:\\Users\\live\\wake-home`.

- [ ] **Step 3: Confirm the runtime behavior**

Run a non-interactive `docker exec` as `wake` to verify `/home/wake/.config` is writable, then rerun `wake-dev sandbox setup` and confirm `gh auth status` reports the authenticated account.

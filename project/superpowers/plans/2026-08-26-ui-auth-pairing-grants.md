# UI Auth Pairing Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Wake UI auth enabled by default while supporting an explicit opt-out and secure short-lived mobile pairing grants.

**Architecture:** Extend the surface credential store with hashed single-use grants. Compose either an authenticated Fastify surface with public grant redemption or an unguarded surface only when the explicit configuration opt-out is set. The CLI creates grants and renders QR handoff information; the React page redeems grants and follows Wake's visual system.

**Tech Stack:** TypeScript, Fastify, `@fastify/secure-session`, React, Vitest, Playwright, terminal QR rendering.

---

### Task 1: Add configuration and credential-grant contracts

**Files:**
- Modify: `src/bootstrap/config/root-schema.ts`
- Modify: `src/surfaces/auth/credentials.ts`
- Modify: `src/surfaces/auth/vocabulary.ts`
- Test: `test/unit/surfaces/auth.test.ts`

- [ ] **Step 1: Write failing tests** for default-enabled auth, explicit `auth.disabled`, ten-minute expiry, single use, and durable-key isolation.

- [ ] **Step 2: Run the focused tests** and confirm they fail because grants/config do not exist.

- [ ] **Step 3: Implement minimal typed config and grant store** using random plaintext grants and persisted hashes.

- [ ] **Step 4: Run focused tests** and confirm they pass.

### Task 2: Compose enabled/disabled Fastify surfaces

**Files:**
- Modify: `src/surfaces/api/http-server.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Test: `test/integration/surfaces/web-server.test.ts`

- [ ] **Step 1: Write failing transport tests** for grant redemption, expiry, session creation, and disabled auth.

- [ ] **Step 2: Run the transport test** and confirm expected failures.

- [ ] **Step 3: Implement the public redeem endpoint and explicit no-auth composition.**

- [ ] **Step 4: Run focused transport tests** and confirm they pass.

### Task 3: Make CLI pairing output usable

**Files:**
- Modify: `src/surfaces/cli/main.ts`
- Modify: `src/surfaces/cli/usage.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Modify: `package.json`
- Test: `test/integration/surfaces/cli-main-contract.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Write failing CLI tests** for a ten-minute grant, both URLs, instructions, and disabled-auth behavior.

- [ ] **Step 2: Run the CLI tests** and confirm expected failure.

- [ ] **Step 3: Implement QR rendering and formatted output** without printing the durable access key.

- [ ] **Step 4: Run focused CLI tests** and confirm they pass.

### Task 4: Build the Wake login experience

**Files:**
- Modify: `src/surfaces/web/src/api/client.ts`
- Modify: `src/surfaces/web/src/app/app.tsx`
- Modify: `src/surfaces/web/src/app/*.css`
- Test: `src/surfaces/web/test/app.test.tsx`
- Test: `src/surfaces/web/e2e/operator-journey.spec.ts`

- [ ] **Step 1: Write failing UI tests** for query grant redemption, URL cleanup, and login presentation.

- [ ] **Step 2: Run focused web tests** and confirm expected failures.

- [ ] **Step 3: Implement grant redemption and responsive Wake-styled two-column login.**

- [ ] **Step 4: Run web unit/browser tests** and confirm they pass.

### Task 5: Verify and deploy locally

**Files:**
- Test: `test/unit/surfaces/auth.test.ts`
- Test: `test/integration/surfaces/web-server.test.ts`
- Test: `test/integration/surfaces/cli-main-contract.test.ts`
- Test: `src/surfaces/web/test/app.test.tsx`

- [ ] **Step 1: Run build, focused tests, and formatting checks.**
- [ ] **Step 2: Build/update the wake-home sandbox.**
- [ ] **Step 3: Verify enabled auth, redeemed pairing grant, consumed grant rejection, and disabled auth locally.**
- [ ] **Step 4: Commit the implementation.**

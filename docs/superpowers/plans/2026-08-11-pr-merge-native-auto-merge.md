# PR Merge Native Auto-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable native GitHub auto-merge to the existing `pr.merge` Activity while preserving safe direct-merge defaults.

**Architecture:** `pr.merge` remains the single policy Activity. It validates `requireApproval`/`autoMerge`, applies the correct review and check policy, and emits an enriched merge intent. Delivery retains one merge intent kind; the GitHub adapter chooses direct merge or native auto-merge and narrowly falls back to direct merge only when GitHub says the PR is already immediately mergeable.

**Tech Stack:** TypeScript, Zod, Vitest, Octokit GitHub REST/GraphQL API, append-only delivery intents.

---

### Task 1: Specify and test merge-policy modes

**Files:**
- Modify: `test/unit/activities/pr-merge.test.ts`
- Modify: `test/unit/activities/pr-merge-policy.test.ts`
- Modify: `src/activities/pr/contracts.ts`
- Modify: `src/activities/pr/policy.ts`
- Modify: `src/activities/pr/merge.ts`

- [ ] **Step 1: Write failing Activity tests**

Add tests that parse defaults as `{ requireApproval: true, autoMerge: false }`, reject `{ requireApproval: false, autoMerge: false }`, allow a pending-check, no-native-review merge only with `{ requireApproval: false, autoMerge: true, requireChecks: true }`, and reject known failing checks in that auto-merge mode.

- [ ] **Step 2: Run the focused tests and confirm they fail because the new input is not supported**

Run: `npx vitest run test/unit/activities/pr-merge.test.ts test/unit/activities/pr-merge-policy.test.ts`

Expected: the new input/default assertions fail before production code is changed.

- [ ] **Step 3: Add the typed input and policy rules**

Extend `PullRequestMergeInput` with `requireApproval` and `autoMerge`. In `merge.ts`, default both fields and reject an unapproved direct merge through the Activity input schema. Pass `requireApproval` to `decidePullRequestAuthority`. Extend its options with an auto-merge check policy: direct merges require currently passing checks; auto-merges permit pending checks but reject unknown and failing states.

- [ ] **Step 4: Re-run the focused Activity tests**

Run: `npx vitest run test/unit/activities/pr-merge.test.ts test/unit/activities/pr-merge-policy.test.ts`

Expected: PASS.

### Task 2: Preserve auto-merge intent through delivery

**Files:**
- Modify: `src/activities/contracts/events.ts`
- Modify: `src/activities/pr/event-drafts.ts`
- Modify: `src/integrations/delivery/application/delivery-projector.ts`
- Modify: `src/integrations/delivery/contracts/views.ts`
- Modify: `test/integration/integrations/delivery-projector.test.ts`

- [ ] **Step 1: Write a failing projector test**

Add a `pr.merge-requested` projection test asserting that an Activity request with `autoMerge: true` creates a `DeliveryIntentKind.PrMerge` view whose payload preserves `autoMerge: true` and the configured merge method.

- [ ] **Step 2: Run the projector test and confirm it fails because the intent does not carry the flag**

Run: `npx vitest run test/integration/integrations/delivery-projector.test.ts`

Expected: FAIL on the missing `autoMerge` payload field.

- [ ] **Step 3: Propagate the field through the typed event and delivery view**

Add `autoMerge` to `PullRequestMergeRequestedPayload`, include it in `deliveryIntentRequested`, and preserve it in the delivery projector and merge payload view. Keep the existing intent kind so delivery-result correlation remains unchanged.

- [ ] **Step 4: Re-run the projector test**

Run: `npx vitest run test/integration/integrations/delivery-projector.test.ts`

Expected: PASS.

### Task 3: Implement GitHub native auto-merge and bounded fallback

**Files:**
- Modify: `src/integrations/github/contracts/vocabulary.ts`
- Modify: `src/integrations/github/application/outbound-translator.ts`
- Modify: `src/integrations/github/infrastructure/client.ts`
- Modify: `test/integration/integrations/github-delivery.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add integration tests proving a merge intent with `autoMerge: true` translates to an `enable-auto-merge` command, and that the client: (a) requests native auto-merge with the selected method; (b) directly merges only after GitHub's known “already mergeable” rejection; and (c) surfaces all other errors without fallback.

- [ ] **Step 2: Run the GitHub delivery test and confirm it fails for missing action/client support**

Run: `npx vitest run test/integration/integrations/github-delivery.test.ts`

Expected: FAIL because the action and client operation are absent.

- [ ] **Step 3: Add the provider operation**

Add an explicit GitHub outbound action for enabling native auto-merge. Use the GitHub API operation that enables auto-merge on a pull request, pass the mapped merge method, and classify only the documented “nothing left to wait for” response as the direct-merge fallback. Retain all other error handling and idempotency behavior.

- [ ] **Step 4: Re-run the GitHub delivery test**

Run: `npx vitest run test/integration/integrations/github-delivery.test.ts`

Expected: PASS.

### Task 4: Document the public configuration contract

**Files:**
- Modify: `docs/workflows.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Document `pr.merge` policy fields**

Document defaults and constraints for `requireApproval`, `autoMerge`, and `requireChecks`, including that `requireApproval: false` is valid only alongside auto-merge and requires a successful independent review watch in the workflow.

- [ ] **Step 2: Document GitHub operator prerequisites**

State that GitHub auto-merge must be enabled for the repository and that branch protection supplies the final required-check gate. Document the direct-merge fallback only for an already-mergeable PR.

### Task 5: Full verification and delivery

**Files:**
- Verify: changed source/tests/docs only

- [ ] **Step 1: Run targeted regression tests**

Run: `npx vitest run test/unit/activities/pr-merge.test.ts test/unit/activities/pr-merge-policy.test.ts test/integration/integrations/delivery-projector.test.ts test/integration/integrations/github-delivery.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run: `npm run verify` and `npm run knip`.

Expected: both commands PASS.

- [ ] **Step 3: Commit and push only feature files**

Run: `git add <changed feature paths>` followed by a conventional feature commit, then `git push origin rewrite/wake-target-architecture`.

Expected: the pushed commits include the design and implementation, with no unrelated dirty-worktree files staged.

### Task 6: Configure the fresh production Wake home

**Files:**
- Modify: `C:/Users/live/wake-home/config.yaml`
- Modify: `C:/Users/live/wake-home/config.workflows.yaml`
- Copy/adapt: `C:/Users/live/wake-home-legacy/prompts/*.md`
- Generate: `C:/Users/live/wake-home/docker/Dockerfile`

- [ ] **Step 1: Translate legacy operational settings into the target schema**

Configure production GitHub intake for `atolis-hq/wake` and its
`atolis-hq-agent` assignee, real Claude/Codex/Cursor runner definitions and
pools, API/web surfaces, source-mode development, and only the five explicit
credential-file mounts already used by the legacy home.

- [ ] **Step 2: Translate workflows and prompts**

Keep the legacy default flow and port the independent plan/PR review watches.
Route `dark-factory` intake tags to a final `pr.merge` stage with
`requireApproval: false`, `autoMerge: true`, squash merging, required checks,
and the legacy changed-file/path bounds. Copy only prompt templates referenced
by the translated workflows and commands, adapting their frontmatter to the
target prompt contract.

- [ ] **Step 3: Validate before building the sandbox**

Run a target `loadConfig` validation and `wake-dev doctor --wake-root
C:/Users/live/wake-home`. Resolve schema, prompt, or runner errors before any
production polling starts.

- [ ] **Step 4: Build a fresh sandbox and validate it**

Run `wake-dev sandbox build`, `up`, and `setup` against the fresh home. Never
copy `.wake/container-home` from the legacy home. Confirm the generated
Dockerfile is current and run the target state/config checks before starting
the resident loop.

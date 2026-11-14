# Mojibake Guard and Approval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent mojibake in committed files and prove `/approved` gates the second Next workflow.

**Architecture:** A focused repository test performs text scanning. The approval workflow is configured using existing orchestration watch/reply behavior and validated both in fixtures and live GitHub.

**Tech Stack:** TypeScript, Vitest, YAML workflow configuration, GitHub CLI.

---

### Task 1: Encoding guard

**Files:**
- Create: `test-next/architecture/no-mojibake.test.ts`
- Modify: corrupted `src-next` text source

- [ ] Write a failing scanner test that reports U+00E2, U+00C3, and U+FFFD in tracked text.
- [ ] Run `npx vitest run --config vitest.next.unit.config.ts test-next/architecture/no-mojibake.test.ts` and observe failure.
- [ ] Repair malformed source and implement exclusions for generated/dependency paths.
- [ ] Re-run the scanner test and verify it passes.

### Task 2: Approval-gated workflow

**Files:**
- Modify: Next workflow fixture/configuration
- Test: focused orchestration/integration test

- [ ] Write a failing test for refine stopping before implement until `/approved`.
- [ ] Run the focused test and observe the pre-implementation failure.
- [ ] Configure the approval stage using existing watch/reply behavior.
- [ ] Re-run the focused test and verify ordinary replies do not advance while `/approved` does.

### Task 3: Final verification

- [ ] Run focused scanner and workflow tests.
- [ ] Run `npm run build:next`.
- [ ] Rebuild/restart the sandbox; create an assigned GitHub issue; verify it waits, post `/approved`, then verify implement starts.
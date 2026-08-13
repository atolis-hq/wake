# CI Failure Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workflows start a bounded repair run only when a PR's checks become failing, and give that run the check evidence it needs.

**Architecture:** Extend the typed watch event configuration with a `checks: failing` predicate, then match it against decoded PR check-change facts. Extend the existing GitHub agent-context reader with a structured current-check snapshot, while retaining the prompt's untrusted-data boundary. Document the resulting `ci-fix` workflow pattern.

**Tech Stack:** TypeScript, Zod, Vitest, Handlebars, YAML.

---

### Task 1: Failure-only watch predicate

**Files:**
- Modify: `src/orchestration/contracts/config.ts`
- Modify: `src/orchestration/application/advance-workflow.ts`
- Test: `test/unit/orchestration/workflow-compiler.test.ts`
- Test: `test/unit/orchestration/watch-reactor.test.ts`

- [ ] **Step 1: Write failing compiler and matcher tests**

```ts
on: { events: [{ type: 'pr.checks-changed', where: { checks: 'failing' } }] }
expect(await service.listWatchMatches('pr.checks-changed', { checks: 'passing' })).toEqual([]);
expect(await service.listWatchMatches('pr.checks-changed', { checks: 'failing' })).toHaveLength(1);
```

- [ ] **Step 2: Run the focused tests and verify they fail because object triggers and payload matching are unsupported.**

Run: `npx vitest run test/unit/orchestration/workflow-compiler.test.ts test/unit/orchestration/watch-reactor.test.ts`

- [ ] **Step 3: Implement the typed predicate and pass event payloads through the watch reactor.**

```ts
type WatchEventTrigger = { readonly type: string; readonly where?: { readonly checks?: 'failing' } };
```

- [ ] **Step 4: Run the focused tests and verify they pass.**

- [ ] **Step 5: Commit the predicate implementation.**

### Task 2: CI evidence in agent context

**Files:**
- Modify: `src/activities/agent/agent-activity.ts`
- Modify: `src/integrations/github/application/agent-context-reader.ts`
- Test: `test/unit/activities/agent-activity.test.ts`
- Test: `test/unit/integrations/github/agent-context-reader.test.ts`

- [ ] **Step 1: Write failing tests for a prompt context containing PR checks and evidence.**

```ts
expect(request.prompt).toContain('"checks": "failing"');
expect(request.prompt).toContain('CI');
```

- [ ] **Step 2: Run those focused tests and verify they fail because the context exposes only title, body, and comments.**

- [ ] **Step 3: Add a `pullRequestChecks` context field and derive it from the latest correlated PR observation.**

```ts
pullRequestChecks: { state: 'failing', checkRuns: [{ name: 'CI', conclusion: 'failure' }], statuses: [] }
```

- [ ] **Step 4: Run the focused tests and verify they pass.**

- [ ] **Step 5: Commit the prompt-context implementation.**

### Task 3: Workflow reference example

**Files:**
- Modify: `docs/workflows.md`
- Test: `test/unit/orchestration/workflow-compiler.test.ts`

- [ ] **Step 1: Add a complete `ci-fix` watch and repair-workflow example under Watches and watch gates.**

```yaml
on:
  events:
    - type: pr.checks-changed
      where: { checks: failing }
```

- [ ] **Step 2: Run the compiler test to verify the documented configuration is supported.**

- [ ] **Step 3: Commit the documentation and final test updates.**

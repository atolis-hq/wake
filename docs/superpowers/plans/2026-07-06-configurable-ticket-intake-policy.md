# Assignee-Based Ticket Intake Matcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `requiredAssignees` matcher to Wake's ticket intake policy so operators can restrict which GitHub issues Wake picks up based on assignee, alongside the existing label matchers.

**Architecture:** Extend the existing `config.sources.github.policy` object (zod schema in `src/domain/schema.ts`) with one new field, `requiredAssignees: string[]`. Enforce it in `src/core/policy-engine.ts`'s `isEligible()`, the single gate already used for `requiredLabels`/`ignoredLabels`, checked every tick. No new modules, no changes to `WorkSource`/GitHub adapter/fake ticketing system — GitHub logins are already ingested into `IssueStateRecord.issue.assignees`.

**Tech Stack:** TypeScript, zod, vitest.

## Global Constraints

- Empty `requiredAssignees` (default `[]`) means no restriction — matches the existing `requiredLabels`/`ignoredLabels` convention exactly.
- Assignee matching is OR-of-list (ticket matches if assigned to **any** listed login); this is combined with the label checks using AND (all configured matcher categories must pass).
- Matcher is rechecked every tick via `isEligible()` — same recheck scope as today's label policy, no "first pickup only" special-casing.
- Identity is the GitHub **login** (username string), not numeric user ID or email.
- Run `npm run verify` (build + test) before considering the work done, per `CLAUDE.md`.

---

### Task 1: Schema — add `requiredAssignees` to the policy config

**Files:**
- Modify: `src/domain/schema.ts:206-209`
- Test: `test/domain/schema.test.ts`

**Interfaces:**
- Produces: `wakeConfigSchema` shape gains `sources.github.policy.requiredAssignees: string[]`. `WakeConfig` (inferred type in `src/domain/types.ts:28`, no manual edit needed — it's `z.infer<typeof wakeConfigSchema>`) automatically picks this up.

- [ ] **Step 1: Read the existing policy schema test for the config shape**

Read `test/domain/schema.test.ts` around lines 200-290 (the two places `requiredLabels`/`ignoredLabels` appear) to see how a full config object is constructed for `parseWakeConfig`/`wakeConfigSchema` in that file, so the new test matches the existing style exactly.

- [ ] **Step 2: Write the failing test**

Add to `test/domain/schema.test.ts` (near the existing `requiredLabels`/`ignoredLabels` config-parsing test — reuse that test's full config object as a base, just adding the new field):

```typescript
it('parses sources.github.policy.requiredAssignees', () => {
  const config = parseWakeConfig({
    // ... copy the exact full config object from the existing
    // requiredLabels/ignoredLabels test in this file, then change
    // the policy block to:
    // policy: {
    //   requiredLabels: [],
    //   ignoredLabels: [],
    //   requiredAssignees: ['octocat'],
    // },
  });

  expect(config.sources.github.policy.requiredAssignees).toEqual(['octocat']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/domain/schema.test.ts -t "requiredAssignees"`
Expected: FAIL — zod strips/rejects the unknown key or the assertion fails because `requiredAssignees` is `undefined`.

- [ ] **Step 4: Add the field to the schema**

In `src/domain/schema.ts`, change:

```typescript
      policy: z.object({
        requiredLabels: z.array(z.string()),
        ignoredLabels: z.array(z.string()),
      }),
```

to:

```typescript
      policy: z.object({
        requiredLabels: z.array(z.string()),
        ignoredLabels: z.array(z.string()),
        requiredAssignees: z.array(z.string()),
      }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/domain/schema.test.ts -t "requiredAssignees"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/domain/schema.ts test/domain/schema.test.ts
git commit -m "feat: add requiredAssignees to ticket intake policy schema"
```

---

### Task 2: Defaults — default `requiredAssignees` to `[]`

**Files:**
- Modify: `src/config/defaults.ts:49-52`
- Test: none new (covered by existing default-config tests; verify they still pass)

**Interfaces:**
- Consumes: `wakeConfigSchema` from Task 1 (now requires `requiredAssignees` on the `policy` object — without this change, `createDefaultWakeConfig()` will throw a zod validation error).

- [ ] **Step 1: Run the existing default-config test suite to confirm it currently breaks**

Run: `npx vitest run test/config`
Expected: FAIL — `createDefaultWakeConfig` throws because `policy.requiredAssignees` is missing (required by the schema change in Task 1). If there is no `test/config` directory, instead run: `npm run build` and expect a TypeScript error citing missing `requiredAssignees`.

- [ ] **Step 2: Add the default value**

In `src/config/defaults.ts`, change:

```typescript
        policy: {
          requiredLabels: [],
          ignoredLabels: [],
        },
```

to:

```typescript
        policy: {
          requiredLabels: [],
          ignoredLabels: [],
          requiredAssignees: [],
        },
```

- [ ] **Step 3: Run the full test suite to verify the fix**

Run: `npm test`
Expected: PASS (all suites, including any that call `createDefaultWakeConfig`)

- [ ] **Step 4: Commit**

```bash
git add src/config/defaults.ts
git commit -m "feat: default requiredAssignees to empty array"
```

---

### Task 3: Policy engine — enforce `requiredAssignees` in `isEligible()`

**Files:**
- Modify: `src/core/policy-engine.ts:5-25`
- Test: Create `test/core/policy-engine.test.ts` (no test file exists yet for this module)

**Interfaces:**
- Consumes: `createPolicyEngine()` from `src/core/policy-engine.ts` (`isEligible(issue: IssueStateRecord, config: WakeConfig): boolean`); `parseIssueStateRecord` from `src/domain/schema.ts` (used in tests to build fixtures — see `test/domain/schema.test.ts` for usage pattern); `createDefaultWakeConfig` from `src/config/defaults.ts`.
- Produces: `isEligible()` now also rejects issues that don't match `requiredAssignees` when it's non-empty.

- [ ] **Step 1: Write the failing tests**

Create `test/core/policy-engine.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { parseIssueStateRecord } from '../../src/domain/schema.js';
import { createPolicyEngine } from '../../src/core/policy-engine.js';

function buildIssue(overrides: {
  labels?: string[];
  assignees?: string[];
}) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 1,
      title: 'Example',
      body: 'Body',
      labels: overrides.labels ?? [],
      assignees: overrides.assignees ?? [],
      state: 'open',
      url: 'https://example.test/issues/1',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    },
    wake: {
      stage: 'queue',
      attempts: 0,
      syncedAt: '2026-07-06T00:00:00.000Z',
      stageHistory: [],
    },
  });
}

describe('policy engine: requiredAssignees', () => {
  it('is eligible when requiredAssignees is empty (no restriction)', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    const issue = buildIssue({ assignees: [] });

    expect(policy.isEligible(issue, config)).toBe(true);
  });

  it('is eligible when issue is assigned to a listed login', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: ['octocat'] });

    expect(policy.isEligible(issue, config)).toBe(true);
  });

  it('is ineligible when issue has no assignees but requiredAssignees is set', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: [] });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is ineligible when issue is assigned to a non-listed login only', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: ['someone-else'] });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is eligible when issue matches any one of multiple requiredAssignees (OR semantics)', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat', 'other-user'];
    const issue = buildIssue({ assignees: ['other-user'] });

    expect(policy.isEligible(issue, config)).toBe(true);
  });

  it('combines requiredAssignees and requiredLabels with AND semantics', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    config.sources.github.policy.requiredLabels = ['wake'];

    const matchesAssigneeOnly = buildIssue({ assignees: ['octocat'], labels: [] });
    const matchesLabelOnly = buildIssue({ assignees: [], labels: ['wake'] });
    const matchesBoth = buildIssue({ assignees: ['octocat'], labels: ['wake'] });

    expect(policy.isEligible(matchesAssigneeOnly, config)).toBe(false);
    expect(policy.isEligible(matchesLabelOnly, config)).toBe(false);
    expect(policy.isEligible(matchesBoth, config)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: FAIL — the "listed login" and "OR semantics" and "combines" tests fail because `isEligible()` doesn't check `requiredAssignees` yet (issues with no matching assignee restriction currently pass regardless of assignees, so the ineligibility assertions fail).

- [ ] **Step 3: Implement the check**

In `src/core/policy-engine.ts`, change:

```typescript
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      const labels = new Set(issue.issue.labels);

      if (issue.issue.state !== 'open') {
        return false;
      }

      if (
        config.sources.github.policy.requiredLabels.some((label) => !labels.has(label))
      ) {
        return false;
      }

      if (
        config.sources.github.policy.ignoredLabels.some((label) => labels.has(label))
      ) {
        return false;
      }

      return true;
    },
```

to:

```typescript
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      const labels = new Set(issue.issue.labels);
      const assignees = new Set(issue.issue.assignees);

      if (issue.issue.state !== 'open') {
        return false;
      }

      if (
        config.sources.github.policy.requiredLabels.some((label) => !labels.has(label))
      ) {
        return false;
      }

      if (
        config.sources.github.policy.ignoredLabels.some((label) => labels.has(label))
      ) {
        return false;
      }

      const requiredAssignees = config.sources.github.policy.requiredAssignees;
      if (
        requiredAssignees.length > 0 &&
        !requiredAssignees.some((login) => assignees.has(login))
      ) {
        return false;
      }

      return true;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions in `tick-runner.test.ts` or elsewhere — they all use the default empty `requiredAssignees`, which is a no-op)

- [ ] **Step 6: Commit**

```bash
git add src/core/policy-engine.ts test/core/policy-engine.test.ts
git commit -m "feat: enforce requiredAssignees in ticket intake eligibility check"
```

---

### Task 4: Documentation — document `requiredAssignees`

**Files:**
- Modify: `docs/configuration.md:217-224` (the `policy` table) and `docs/configuration.md:49-61` (the example config block, if it enumerates `policy` fields)

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Read the current example config block**

Read `docs/configuration.md` lines 40-65 to see the exact JSON example that currently shows:
```json
        "requiredLabels": [],
        "ignoredLabels": []
```
and confirm whether it's a full-config example (needs the new field added for completeness) or a partial snippet.

- [ ] **Step 2: Update the example config block**

If the block enumerates the `policy` object, change:

```json
        "requiredLabels": [],
        "ignoredLabels": []
```

to:

```json
        "requiredLabels": [],
        "ignoredLabels": [],
        "requiredAssignees": []
```

- [ ] **Step 3: Update the policy reference table**

In `docs/configuration.md`, change:

```markdown
| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `requiredLabels` | string[] | Only process issues with all of these labels (empty = no requirement) | `[]` |
| `ignoredLabels` | string[] | Ignore issues with any of these labels | `[]` |
```

to:

```markdown
| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `requiredLabels` | string[] | Only process issues with all of these labels (empty = no requirement) | `[]` |
| `ignoredLabels` | string[] | Ignore issues with any of these labels | `[]` |
| `requiredAssignees` | string[] | Only process issues assigned to at least one of these GitHub logins (empty = no requirement) | `[]` |
```

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: document requiredAssignees ticket intake policy"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full verify pipeline**

Run: `npm run verify`
Expected: build succeeds, all tests pass.

- [ ] **Step 2: Confirm no other config fixtures need updating**

Run: `npx vitest run` and check for any failures in adapters/e2e tests that construct a full config object literal (rather than via `createDefaultWakeConfig`) which might now be missing `requiredAssignees` and fail zod parsing — e.g. `test/scripts/e2e-github-fake.test.ts` and `test/adapters/claude-runner.test.ts:239-240` build a `policy: { requiredLabels: [], ignoredLabels: [] }` object directly.

If any such fixture fails schema parsing due to the missing field, add `requiredAssignees: []` to that fixture's `policy` object and re-run.

- [ ] **Step 3: Commit any fixture fixes**

```bash
git add -A
git commit -m "test: add requiredAssignees to hand-built config fixtures"
```

(Skip this commit if no fixtures needed changes.)

# Cron Parser Schedule Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delegate five-field UTC schedule occurrence calculation to `cron-parser` without changing Wake's durable slot behaviour.

**Architecture:** `SchedulePolicy` retains its API, five-field boundary, checkpoint semantics, and stable identities. `cron-parser` provides validation and UTC occurrences; `ScheduleService` retains durable processing.

**Tech Stack:** TypeScript 6, Vitest 4, `cron-parser` 5, npm.

---

## File structure

- `package.json`, `package-lock.json`: runtime parser dependency.
- `src/control-plane/domain/schedule-policy.ts`: parser-to-slot adapter.
- `test/unit/control-plane/schedule-policy.test.ts`: grammar and UTC coverage.
- `docs/configuration.md`, `src/control-plane/domain/schedule-policy.spec.md`: current grammar contract.

### Task 1: Define parser behaviour with failing tests

**Files:**
- Modify: `test/unit/control-plane/schedule-policy.test.ts`

- [ ] **Step 1: Add the range-and-alias test**

```ts
it('returns slots for ranges and named month and weekday fields', () => {
  const policy = new SchedulePolicy();
  const named = { ...config, cron: '0 9-10 * JAN MON' };
  expect(policy.elapsedSlots(named, '2026-01-05T10:01:00.000Z', '2026-01-05T08:59:00.000Z')).toEqual([
    { identity: 'schedule:nightly:2026-01-05T09:00:00.000Z', at: '2026-01-05T09:00:00.000Z' },
    { identity: 'schedule:nightly:2026-01-05T10:00:00.000Z', at: '2026-01-05T10:00:00.000Z' },
  ]);
});
```

- [ ] **Step 2: Add invalid and UTC tests**

```ts
it('rejects invalid syntax and seconds fields', () => {
  const policy = new SchedulePolicy();
  expect(() => policy.elapsedSlots({ ...config, cron: '60 * * * *' }, '2026-01-01T00:00:00.000Z', null)).toThrow();
  expect(() => policy.elapsedSlots({ ...config, cron: '* * * * * *' }, '2026-01-01T00:00:00.000Z', null)).toThrow('five-field cron expression');
});

it('evaluates schedules in UTC', () => {
  const policy = new SchedulePolicy();
  expect(policy.elapsedSlots({ ...config, cron: '0 0 * * *' }, '2026-01-01T00:00:00.000Z', null)).toEqual([
    { identity: 'schedule:nightly:2026-01-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' },
  ]);
});
```

- [ ] **Step 3: Verify the tests fail**

Run `npx vitest run test/unit/control-plane/schedule-policy.test.ts`.

Expected: FAIL because the bespoke matcher rejects ranges and aliases.

### Task 2: Replace the matcher

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/control-plane/domain/schedule-policy.ts`
- Test: `test/unit/control-plane/schedule-policy.test.ts`

- [ ] **Step 1: Add the dependency**

Run `npm install cron-parser`.

Expected: it is a runtime dependency and the lockfile contains its Luxon transitive dependency.

- [ ] **Step 2: Implement a parser adapter**

Import `CronExpressionParser`. Require `cron.trim().split(/\s+/).length === 5`; otherwise throw the current five-field error. Parse with `currentDate: new Date(start - 1)`, `endDate: new Date(end)`, and `tz: 'UTC'`. Repeatedly call `next().toDate().getTime()` until the parser's end-of-range error, then map occurrences to the unchanged ISO timestamp and `schedule:<id>:<timestamp>` identity. Preserve timestamp validation and the `start > end` early return. Delete `matches` and `matchesField`.

- [ ] **Step 3: Verify the focused suite passes**

Run `npx vitest run test/unit/control-plane/schedule-policy.test.ts test/e2e/scenarios/schedule-restart.test.ts`.

Expected: PASS.

- [ ] **Step 4: Commit the implementation**

Run `git add package.json package-lock.json src/control-plane/domain/schedule-policy.ts test/unit/control-plane/schedule-policy.test.ts; git commit -m "refactor: parse schedule cron expressions with cron-parser"`.

### Task 3: Document the actual grammar

**Files:**
- Modify: `docs/configuration.md`
- Modify: `src/control-plane/domain/schedule-policy.spec.md`

- [ ] **Step 1: Update configuration documentation**

State the five fields, UTC evaluation, and support for lists, ranges, steps, and `JAN`–`DEC`/`SUN`–`SAT` aliases. State that six-field seconds expressions and time-zone configuration are unsupported.

- [ ] **Step 2: Align the component specification**

Replace the bespoke-only matching invariant with the parser-backed five-field UTC grammar. Retain every checkpoint, identity, and service-ownership invariant.

- [ ] **Step 3: Verify docs, formatting, and build**

Run `npm run check:specs; npm run format:check; npm run build`.

Expected: all exit 0.

- [ ] **Step 4: Commit documentation**

Run `git add docs/configuration.md src/control-plane/domain/schedule-policy.spec.md; git commit -m "docs: describe supported schedule cron grammar"`.

### Task 4: Verify the complete change

**Files:**
- Verify: `package.json`, `src/control-plane/domain/schedule-policy.ts`, `test/unit/control-plane/schedule-policy.test.ts`, `test/e2e/scenarios/schedule-restart.test.ts`

- [ ] **Step 1: Run affected and quality checks**

Run `npm run test:unit -- --run test/unit/control-plane/schedule-policy.test.ts; npm run test:e2e -- --run test/e2e/scenarios/schedule-restart.test.ts; npm run lint; npm run format:check; npm run build`.

Expected: all exit 0.

- [ ] **Step 2: Inspect the final diff**

Run `git diff main...HEAD --check; git status --short`.

Expected: no whitespace errors and a clean worktree.

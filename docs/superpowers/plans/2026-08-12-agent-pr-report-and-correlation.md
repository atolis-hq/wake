# Agent PR report and correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a prose PR link in terminal agent reports while registering the accompanying fenced PR declaration against its WorkItem.

**Architecture:** The implementation prompt requires the prose link and the `wake-artifacts` fence as two separate outputs. Existing parsers retain the visible report while extracting only the typed artifact claim, and the registration reactor verifies and correlates it.

**Tech Stack:** TypeScript, Vitest, Zod, event journal projections.

---

### Task 1: Preserve the human-facing PR report contract

**Files:**

- Modify: `src/bootstrap/initialise.ts:174-187`
- Test: `test/integration/bootstrap/initialise.test.ts:77-96`

- [ ] **Step 1: Write the failing test**

```ts
if (name === 'implement') {
  expect(rendered).toContain('Include every pull request URL in the normal prose response.');
  expect(rendered).toContain('Then repeat each URL in this exact artifact fence');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/bootstrap/initialise.test.ts`

Expected: FAIL because the implement template does not require the prose URL and fence as separate representations.

- [ ] **Step 3: Write minimal implementation**

```text
Include every pull request URL in the normal prose response. Then repeat each
URL in this exact artifact fence immediately below the prose report:
```

Keep the existing `wake-artifacts` JSON example and final-status requirement.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/bootstrap/initialise.test.ts`

Expected: PASS.

### Task 2: Retain visible prose and fenced metadata in the published report

**Files:**

- Test: `test/unit/execution/fake-runner.test.ts:11-34`

- [ ] **Step 1: Write the failing test**

```ts
expect(response).toMatchObject({ outcome: 'DONE' });
expect(response.displayBody).toContain('https://github.com/atolis-hq/wake/pull/537');
expect(response.displayBody).toContain('```wake-artifacts');
expect(response.displayBody).not.toContain('\nDONE');
```

Use a raw agent output containing prose, the fence, and a final `DONE` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/fake-runner.test.ts`

Expected: FAIL if terminal parsing discards either the prose link or fenced declaration.

- [ ] **Step 3: Write minimal implementation**

Only change `src/execution/infrastructure/agent-runner-adapter.ts` if the failing test demonstrates that its existing terminal-sentinel branch does not preserve the report body. Remove only the terminal sentinel; retain preceding prose and fences.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/fake-runner.test.ts`

Expected: PASS.

### Task 3: Correlate a raw reported PR with its originating WorkItem

**Files:**

- Modify: `test/integration/integrations/artifact-registration-reactor.test.ts:12-99`
- Test: `test/unit/activities/agent-result.test.ts:46-66`

- [ ] **Step 1: Write the failing test**

```ts
const outcome = translateAgentResult(rawAgentOutput);
// append outcome.data as the accepted activity outcome
await reactor.runOnce();
await expect(resources.correlations(resource!.resourceId)).resolves.toMatchObject([
  { workItemId: workId('artifact-work'), role: 'primary', provenance: 'agent-reported' },
]);
```

The raw output must contain the prose PR URL, `wake-artifacts` fence, and `DONE` sentinel.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/integrations/artifact-registration-reactor.test.ts test/unit/activities/agent-result.test.ts`

Expected: FAIL if raw fence parsing does not forward a typed claim into the reactor.

- [ ] **Step 3: Write minimal implementation**

If the failure exposes missing raw-result extraction, update `src/activities/agent/agent-result.ts` so `wakeArtifacts` produces `{ kind: 'pull-request', externalKey: { adapter: 'github', key: 'owner/repo#number' } }` from each valid PR URL, leaving malformed fences as prose only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/integrations/artifact-registration-reactor.test.ts test/unit/activities/agent-result.test.ts`

Expected: PASS.

### Task 4: Verify the scoped change

**Files:**

- Verify: `src/bootstrap/initialise.ts`
- Verify: `src/execution/infrastructure/agent-runner-adapter.ts`
- Verify: `src/activities/agent/agent-result.ts`

- [ ] **Step 1: Run the focused regression suite**

Run: `npx vitest run test/integration/bootstrap/initialise.test.ts test/unit/execution/fake-runner.test.ts test/unit/activities/agent-result.test.ts test/integration/integrations/artifact-registration-reactor.test.ts`

Expected: PASS with no failures.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`

Expected: exit code 0.

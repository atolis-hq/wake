# Optional Fake-Runner Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional deterministic `fake-scenarios.yaml` support for target Wake homes, retaining immediate successful fake runs when absent or unmatched.

**Architecture:** Bootstrap parses the optional fixture outside root/runner configuration and injects a read-only resolver into named fake runners. The composed execution path provides runner, workflow, action, and activation ordinal metadata, allowing deterministic retry/reviewer rules without process-local state.

**Tech Stack:** TypeScript, Zod, YAML, Node abort signals, Vitest.

---

## File structure

- Create `src-next/execution/infrastructure/runners/fake-scenarios.ts`: strict scenario schema, ordered rule resolver, and seeded delay calculation.
- Modify `src-next/execution/infrastructure/runners/fake.ts`: default-pass, delayed/cancellable configured outcomes.
- Modify `src-next/execution/contracts/runner.ts`, `src-next/activities/contracts/activity.ts`, `src-next/activities/agent/agent-activity.ts`, `src-next/execution/contracts/commands.ts`, `src-next/execution/application/execution-service.ts`, and `src-next/control-plane/application/advance-once.ts`: pass durable scenario matching metadata.
- Create `src-next/bootstrap/fake-scenarios.ts`; modify `src-next/bootstrap/runner-registry.ts`, `src-next/bootstrap/composition-root.ts`, and `src-next/bootstrap/surface-cli-applications.ts`: load and compose the optional file.
- Create focused unit/E2E tests and a `wake-root-fake-scenarios` fixture; update current configuration/workflow/setup documentation.

### Task 1: Model standalone fake scenarios

**Files:**
- Create: `src-next/execution/infrastructure/runners/fake-scenarios.ts`
- Test: `test-next/unit/execution/fake-scenarios.test.ts`

- [ ] **Step 1: Write failing schema/match tests**

```ts
it('uses the first matching worker/workflow/action/occurrence rule', () => {
  const scenarios = parseFakeScenarios({ schemaVersion: 1, rules: [
    { name: 'retry', when: { runner: 'fake-worker', workflow: 'dark-factory', action: 'refine', occurrence: 1 }, afterMs: 7000, outcome: 'FAILED', retrySafety: 'safe-to-retry' },
  ] });
  expect(scenarios.resolve({ runner: 'fake-worker', workflow: 'dark-factory', action: 'refine', occurrence: 1 })).toMatchObject({ outcome: 'FAILED', delayMs: 7000 });
});
```

- [ ] **Step 2: Confirm the test fails**

Run: `npx vitest run test-next/unit/execution/fake-scenarios.test.ts`

Expected: FAIL because the parser/resolver does not exist.

- [ ] **Step 3: Implement a strict resolver**

```ts
export const fakeScenariosSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(fakeScenarioRuleSchema).default([]),
}).strict();

export function resolveFakeScenario(input: FakeScenarioMatch): ResolvedFakeScenario | undefined {
  const rule = rules.find((candidate) => matches(candidate.when, input));
  return rule === undefined ? undefined : { ...rule, delayMs: resolveDelay(rule.afterMs, input) };
}
```

Require unique names, positive fixed delays, `min <= max`, a seed for ranges, and `retrySafety: safe-to-retry` only for `FAILED`. Hash seed plus matching fields to select a stable inclusive value.

- [ ] **Step 4: Test invalid schemas, unmatched rules, and repeatable ranges**

Run: `npx vitest run test-next/unit/execution/fake-scenarios.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-next/execution/infrastructure/runners/fake-scenarios.ts test-next/unit/execution/fake-scenarios.test.ts
git commit -m "feat(next): define fake runner scenarios"
```

### Task 2: Simulate fake outcomes without changing default behavior

**Files:**
- Modify: `src-next/execution/contracts/runner.ts`
- Modify: `src-next/execution/infrastructure/runners/fake.ts`
- Modify: `src-next/execution/index.ts`
- Test: `test-next/unit/execution/fake-runner.test.ts`

- [ ] **Step 1: Add failing default, delay, abort, and outcome tests**

```ts
it('immediately returns DONE without a matching scenario', async () => {
  await expect((await runner.start(request, signal)).result).resolves.toMatchObject({ output: JSON.stringify({ status: 'DONE' }) });
});
it('settles promptly when aborted during a configured delay', async () => {
  const execution = await delayedRunner.start(request, controller.signal);
  controller.abort();
  await expect(execution.result).rejects.toThrow(/aborted/i);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test-next/unit/execution/fake-runner.test.ts`

Expected: FAIL because the fake runner is immediate and ignores cancellation.

- [ ] **Step 3: Implement scenario-aware requests and cancellation**

```ts
export interface RunnerRequest {
  readonly runId: string;
  readonly simulation?: { readonly runner: string; readonly workflow: string; readonly action: string; readonly occurrence: number };
  // existing fields unchanged
}
const rule = request.simulation === undefined ? undefined : this.scenarios.resolve(request.simulation);
return { result: resolveAfter(rule?.delayMs ?? 0, signal).then(() => fakeResult(this.name, rule)), cancel: async () => {} };
```

Serialize `DONE`, `BLOCKED`, `FAILED`, and `REJECTED`, optional retry safety, and optional display body in the existing agent envelope. A no-rule result remains immediate `DONE`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test-next/unit/execution/fake-runner.test.ts`

Expected: PASS.

```bash
git add src-next/execution/contracts/runner.ts src-next/execution/infrastructure/runners/fake.ts src-next/execution/index.ts test-next/unit/execution/fake-runner.test.ts
git commit -m "feat(next): simulate fake runner outcomes"
```

### Task 3: Load the optional file and inject it into fake runners

**Files:**
- Create: `src-next/bootstrap/fake-scenarios.ts`
- Modify: `src-next/bootstrap/runner-registry.ts`, `src-next/bootstrap/composition-root.ts`, `src-next/bootstrap/surface-cli-applications.ts`
- Test: `test-next/unit/bootstrap/fake-scenarios.test.ts`, `test-next/integration/bootstrap/runtime.test.ts`

- [ ] **Step 1: Write failing loader tests**

```ts
await expect(loadFakeScenarios(tempRoot)).resolves.toEqual(emptyFakeScenarios);
await writeFile(join(tempRoot, 'fake-scenarios.yaml'), 'schemaVersion: 2\n');
await expect(loadFakeScenarios(tempRoot)).rejects.toThrow(/fake-scenarios.yaml/);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test-next/unit/bootstrap/fake-scenarios.test.ts`

Expected: FAIL because the loader is absent.

- [ ] **Step 3: Implement optional loading and named runner injection**

```ts
export async function loadFakeScenarios(wakeRoot: string): Promise<FakeScenarioResolver> {
  const source = await readYamlIfPresent(join(wakeRoot, 'fake-scenarios.yaml'));
  return source === undefined ? emptyFakeScenarios : parseFakeScenarios(source);
}
case 'fake': return new FakeExecutionRunner(name, scenarios);
```

Load once per production composition root. Do not add any scenario fields to `executionConfigSchema` or `config.yaml`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test-next/unit/bootstrap/fake-scenarios.test.ts test-next/integration/bootstrap/runtime.test.ts`

Expected: PASS.

```bash
git add src-next/bootstrap/fake-scenarios.ts src-next/bootstrap/runner-registry.ts src-next/bootstrap/composition-root.ts src-next/bootstrap/surface-cli-applications.ts test-next/unit/bootstrap/fake-scenarios.test.ts test-next/integration/bootstrap/runtime.test.ts
git commit -m "feat(next): load optional fake runner scenarios"
```

### Task 4: Supply durable workflow metadata to an agent runner

**Files:**
- Modify: `src-next/execution/contracts/commands.ts`, `src-next/control-plane/application/advance-once.ts`, `src-next/execution/application/execution-service.ts`
- Modify: `src-next/activities/contracts/activity.ts`, `src-next/activities/agent/agent-activity.ts`
- Test: `test-next/unit/execution/execution-service.test.ts`

- [ ] **Step 1: Write a failing composed-path assertion**

```ts
expect(receivedRequest.simulation).toEqual({
  runner: 'fake-worker', workflow: 'dark-factory', action: 'refine', occurrence: 2,
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test-next/unit/execution/execution-service.test.ts`

Expected: FAIL because agent requests carry only rendered prompt data.

- [ ] **Step 3: Add `workflowName` to `ExecutionAttemptContext` and forward metadata**

Use `activation.ordinal` as `occurrence`, the selected runner registry name as `runner`, the workflow instance’s configured name as `workflow`, and the agent `template` as `action`. Pass metadata only to agent activity requests. CLI runner adapters continue to ignore it.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test-next/unit/execution/execution-service.test.ts test-next/unit/execution/fake-runner.test.ts`

Expected: PASS.

```bash
git add src-next/execution/contracts/commands.ts src-next/control-plane/application/advance-once.ts src-next/execution/application/execution-service.ts src-next/activities/contracts/activity.ts src-next/activities/agent/agent-activity.ts test-next/unit/execution/execution-service.test.ts test-next/unit/execution/fake-runner.test.ts
git commit -m "feat(next): identify fake scenario invocations"
```

### Task 5: Exercise retry and reviewer side effects through dark factory

**Files:**
- Create: `test-next/e2e/scenarios/fake-scenarios.test.ts`
- Create: `test-next/e2e/fixtures/wake-root-fake-scenarios/config.yaml`
- Create: `test-next/e2e/fixtures/wake-root-fake-scenarios/config.workflows.yaml`
- Create: `test-next/e2e/fixtures/wake-root-fake-scenarios/fake-scenarios.yaml`

- [ ] **Step 1: Write a failing composed E2E scenario**

```ts
defineScenario({
  id: 'E2E-FAKE-SCENARIOS-001',
  title: 'a fake dark-factory worker retries and a fake reviewer requests changes',
  given: ['a dark-factory work item and optional fake scenarios'],
  when: ['refine fails safely once, succeeds on retry, then PR review runs'],
  then: ['two runs remain immutable, retry count is one, and feedback prevents merge approval'],
}, async () => { /* compose fixture and assert views/outbox */ });
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test-next/e2e/scenarios/fake-scenarios.test.ts`

Expected: FAIL because the fixture/scenario is absent.

- [ ] **Step 3: Add the fixture**

Create worker/reviewer fake pools. Select `dark-factory` with its label/tag. Configure failed routing as `failed: { retry: { max: 1 }, then: await-human }`; rules make refine occurrence 1 safe `FAILED`, occurrence 2 `DONE`, and `pr-review` `REJECTED` with visible feedback.

- [ ] **Step 4: Run the scenario and commit**

Run: `npx vitest run test-next/e2e/scenarios/fake-scenarios.test.ts`

Expected: PASS.

```bash
git add test-next/e2e/scenarios/fake-scenarios.test.ts test-next/e2e/fixtures/wake-root-fake-scenarios
git commit -m "test(next): cover fake dark factory scenarios"
```

### Task 6: Document the optional operator fixture

**Files:**
- Modify: `docs/configuration.md`, `docs/workflows.md`, `templates/SETUP.md`
- Test: relevant documentation/configuration tests

- [ ] **Step 1: Document the contract**

State the file location, that it is optional, and that no file/no match is immediate `DONE`. Include fixed and seeded delay examples, ordered matching, all supported outcomes, cancellation, retry safety, and worker/reviewer dark-factory usage. Explicitly say these fields do not belong under `execution.agentRunners`.

- [ ] **Step 2: Verify documentation and target behavior**

Run: `npm run check:specs; npx vitest run test-next/unit/bootstrap/fake-scenarios.test.ts test-next/e2e/scenarios/fake-scenarios.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md docs/workflows.md templates/SETUP.md
git commit -m "docs: explain fake runner scenarios"
```

### Task 7: Run required verification

**Files:** Verify only.

- [ ] **Step 1: Run target quality gates**

Run: `npm run lint:contracts; npm run lint:architecture; npm run knip:next; npm run verify:next`

Expected: every command exits 0.

- [ ] **Step 2: Run legacy compatibility gate**

Run: `npm run verify`

Expected: exit 0.

- [ ] **Step 3: Inspect final changes**

Run: `git status --short; git diff --check`

Expected: only intended changes are present and the diff check is silent.

## Plan self-review

- Scenario schema, optional loading, immediate-pass default, seeded timing, cancellation, worker retry, fake reviewer outcomes, dark-factory side effects, docs, and target/legacy verification are covered.
- The identifiers used throughout are consistent: `runner`, `workflow`, `action`, and `occurrence`.
- The plan deliberately keeps scenario data out of runner configuration.


# Runner-Quota Transparent Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a provider usage-limit/quota/rate-limit response from any agent runner CLI (Codex, Claude, Cursor), pause that runner in its pool, and transparently retry the interrupted stage on another pool member next tick — without it ever becoming a workflow `failed` outcome (no GitHub publication, no consumption of the workflow's configured retry budget). When every runner in a pool is currently ineligible, stop the dispatch loop for that tick instead of crashing.

**Architecture:** Each CLI runner adapter gains a `classifyFailure` hook that inspects stdout/stderr (or, for Codex, its JSONL error events) and tags a transport failure with a shared `provider-quota-exceeded` kind. That flows through the already-existing (but currently unreachable) `reportRunnerQuota` → `RunnerPaused` → `ineligibleRunners` pipeline unchanged. Separately, `agent-activity.ts` tags the resulting business outcome with a new `ActivityFailureCode.RunnerQuotaExceeded` so `advance-once-dispatch.ts` can intercept it before calling `orchestration.acceptOutcome`, routing it instead to a new orchestration operation that resolves the current activation and re-requests the stage's activity — mirroring the existing `operator-retry-policy.ts` pattern but automatic rather than operator-commanded, and without a `RetryCounted` event. Full-pool exhaustion gets a typed `NoEligibleRunnerError` that the dispatch loop catches gracefully.

**Tech Stack:** TypeScript, Vitest, Wake's event-sourced kernel (`EventJournal`, `ProjectionDefinition`).

**Spec:** `docs/superpowers/specs/2026-08-19-runner-quota-transparent-retry-design.md`

## Global Constraints

- Do not introduce magic strings for the quota failure kind — use the shared exported constant everywhere it's compared.
- `ActivityFailureCode`, `OrchestrationEventType`, and `ExecutionCancellationReason` are closed vocabularies (`defineClosedVocabulary`) — add new members there, never compare against raw string literals in application code.
- Do not touch `resolveRunnerQuotaResumeAt`, `RunnerControlService`, or manual pause/unpause — already correct, out of scope.
- Do not add the full visible/auto-resuming `WorkflowStatus` for pool exhaustion in this plan — that is an explicitly deferred follow-on (see spec's "Pool exhaustion" section).
- Every new/changed file must pass `npm run lint` and `npm run lint:architecture` (module boundary and vocabulary checks) before a task is considered done.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/execution/contracts/runner.ts` | Add `ProviderQuotaExceededFailureKind` shared constant. |
| `src/execution/infrastructure/runners/claude.ts` | `cliRunner`'s `classifyFailure` hook plumbing; Claude's own classifier. |
| `src/execution/infrastructure/runners/codex.ts` | Codex's JSONL-aware classifier. |
| `src/execution/infrastructure/runners/cursor.ts` | Cursor's classifier. |
| `src/execution/infrastructure/runners/registry.ts` | Typed `NoEligibleRunnerError`. |
| `src/activities/contracts/vocabulary.ts` | New `ActivityFailureCode.RunnerQuotaExceeded` member. |
| `src/activities/agent/agent-result.ts` | Schema accepts the new reason. |
| `src/activities/agent/agent-activity.ts` | Tags a quota transport failure distinctly in `agentOutcome()`. |
| `src/orchestration/contracts/events.ts` | New `OrchestrationEventType.ActivityRetriedForRunnerQuota` + payload type. |
| `src/orchestration/domain/workflow-instance-events.ts` | Fold handling for the new event type. |
| `src/orchestration/domain/runner-quota-retry-policy.ts` | New file: pure decision function, mirrors `operator-retry-policy.ts`. |
| `src/orchestration/domain/interpreter.ts` | Re-export the new domain function. |
| `src/orchestration/application/advance-workflow.ts` | New `retryRunnerQuotaFailure` method. |
| `src/orchestration/application/orchestration-service.ts` | Delegating wrapper. |
| `src/control-plane/application/advance-once-ports.ts` | New optional `OrchestrationPort.retryRunnerQuotaFailure` method. |
| `src/control-plane/application/advance-once-dispatch.ts` | Intercept quota outcomes before `acceptOutcome`; catch `NoEligibleRunnerError`. |

---

### Task 1: Shared quota-failure-kind constant and `cliRunner` classification hook

**Files:**
- Modify: `src/execution/contracts/runner.ts`
- Modify: `src/execution/infrastructure/runners/claude.ts:99-158`
- Test: `test/integration/execution/process-execution.test.ts`

**Interfaces:**
- Produces: `ProviderQuotaExceededFailureKind = 'provider-quota-exceeded'` (exported string constant); `cliRunner(name, command, args, options)`'s `options.classifyFailure?: (input: { readonly stdout: string; readonly stderr: string }) => { readonly kind: string; readonly message: string } | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/execution/process-execution.test.ts`, right after the existing `'returns captured stdout and stderr detail for a non-zero process exit'` test (~line 188), reusing that test's exact inline-script style:

```ts
it('classifies a process failure using the supplied classifier before falling back to process-exit', async () => {
  const runner = cliRunner(
    'test-cli',
    process.execPath,
    () => [
      '-e',
      'process.stdout.write("stdout text"); process.stderr.write("stderr text"); process.exit(7)',
    ],
    {
      classifyFailure: ({ stdout, stderr }) =>
        stdout.includes('stdout text') || stderr.includes('stderr text')
          ? { kind: 'provider-quota-exceeded', message: 'classified quota message' }
          : undefined,
    },
  );
  const execution = await runner.start(
    { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
    new AbortController().signal,
  );
  await expect(execution.result).resolves.toMatchObject({
    transport: 'failed',
    failure: { kind: 'provider-quota-exceeded', message: 'classified quota message' },
  });
});

it('falls back to process-exit when the classifier does not recognize the failure', async () => {
  const runner = cliRunner(
    'test-cli',
    process.execPath,
    () => [
      '-e',
      'process.stdout.write("stdout text"); process.stderr.write("stderr text"); process.exit(7)',
    ],
    { classifyFailure: () => undefined },
  );
  const execution = await runner.start(
    { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
    new AbortController().signal,
  );
  await expect(execution.result).resolves.toMatchObject({
    transport: 'failed',
    failure: { kind: 'process-exit' },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts -t "classifies a process failure"`
Expected: FAIL — `classifyFailure` is not a recognized option / failure kind stays `process-exit`.

- [ ] **Step 3: Implement**

In `src/execution/contracts/runner.ts`, add near the top (after imports, before `RunnerRequest`):

```ts
export const ProviderQuotaExceededFailureKind = 'provider-quota-exceeded';
```

In `src/execution/infrastructure/runners/claude.ts`, extend `CliRunnerOptions`'s inline options parameter and the failure branch (replace lines 99-158's `options` type and the `result:` failure object):

```ts
export function cliRunner(
  name: string,
  command: string,
  args: (request: RunnerRequest) => string[],
  options: {
    readonly timeoutMs?: number;
    readonly defaultModel?: string;
    readonly supportsSessionResume?: boolean;
    readonly parseSuccessfulOutput?: (
      stdout: string,
      request: RunnerRequest,
    ) => Partial<AgentRunnerResult>;
    readonly classifyFailure?: (input: {
      readonly stdout: string;
      readonly stderr: string;
    }) => { readonly kind: string; readonly message: string } | undefined;
  } = {},
): Runner {
  return {
    supportsSessionResume: options.supportsSessionResume === true,
    async start(request, signal): Promise<RunnerExecution> {
      const process = runProcess(
        command,
        args(request),
        request.workspacePath,
        signal,
        options.timeoutMs,
      );
      return {
        identity: {
          kind: ExternalExecutionKind.Process,
          id: request.runId,
          startedAt: new Date().toISOString(),
        },
        result: process.result.then((value): AgentRunnerResult =>
          value.exitCode === 0 && !value.timedOut
            ? {
                transport: RunStatus.Succeeded,
                output: value.stdout,
                runner: name,
                ...((request.model ?? options.defaultModel) === undefined
                  ? {}
                  : { model: request.model ?? options.defaultModel }),
                ...parseSuccessfulOutput(value.stdout, request, options.parseSuccessfulOutput),
              }
            : {
                transport: RunStatus.Failed,
                output: value.stdout,
                runner: name,
                failure: failureFor(value, options),
              },
        ),
        cancel: process.cancel,
      };
    },
  };
}

function failureFor(
  value: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly failureKind?: 'output-limit';
    readonly failureMessage?: string;
  },
  options: {
    readonly timeoutMs?: number;
    readonly classifyFailure?: (input: {
      readonly stdout: string;
      readonly stderr: string;
    }) => { readonly kind: string; readonly message: string } | undefined;
  },
): { readonly kind: string; readonly message: string } {
  if (value.timedOut)
    return {
      kind: ExecutionCancellationReason.Timeout,
      message: `Runner timed out after ${options.timeoutMs}ms`,
    };
  if (value.failureKind !== undefined)
    return {
      kind: value.failureKind,
      message: value.failureMessage ?? (value.stderr || `exit ${value.exitCode}`),
    };
  const classified = options.classifyFailure?.({ stdout: value.stdout, stderr: value.stderr });
  if (classified !== undefined) return classified;
  return { kind: 'process-exit', message: value.stderr || `exit ${value.exitCode}` };
}
```

This is a behavior-preserving refactor for every existing caller (none pass `classifyFailure` yet, so `failureFor` falls through to the same `process-exit`/`output-limit`/`timeout` results as before).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`
Expected: PASS, including all pre-existing tests in the file (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/execution/contracts/runner.ts src/execution/infrastructure/runners/claude.ts test/integration/execution/process-execution.test.ts
git commit -m "feat(execution): add classifyFailure hook to shared cliRunner"
```

---

### Task 2: Codex quota classifier

**Files:**
- Modify: `src/execution/infrastructure/runners/codex.ts`
- Test: `test/integration/execution/process-execution.test.ts`

**Interfaces:**
- Consumes: `ProviderQuotaExceededFailureKind` (Task 1), `cliRunner`'s `classifyFailure` option (Task 1).
- Produces: `classifyCodexFailure(input: { readonly stdout: string; readonly stderr: string }): { readonly kind: string; readonly message: string } | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/execution/process-execution.test.ts`:

```ts
it('classifies a Codex usage-limit turn.failed event as provider-quota-exceeded', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'error',
      message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM.",
    }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM." },
    }),
  ].join('\n');

  expect(classifyCodexFailure({ stdout, stderr: '' })).toEqual({
    kind: 'provider-quota-exceeded',
    message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM.",
  });
});

it('does not classify an ordinary Codex crash as quota-exceeded', () => {
  expect(classifyCodexFailure({ stdout: '', stderr: 'Segmentation fault' })).toBeUndefined();
});

it('does not classify an auth failure as quota-exceeded', () => {
  const stdout = JSON.stringify({
    type: 'error',
    message: 'Unauthorized: authentication failed, please run `codex login`.',
  });
  expect(classifyCodexFailure({ stdout, stderr: '' })).toBeUndefined();
});

it('does not scan raw stdout when no structured error/turn.failed event is present', () => {
  // The word "quota" appears in this agent-generated line, but it is not a
  // structured Codex error event, so it must never be classified as quota.
  const stdout = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'I updated the quota-check middleware and committed.' },
  });
  expect(classifyCodexFailure({ stdout, stderr: '' })).toBeUndefined();
});
```

Add `classifyCodexFailure` to the file's existing import of Codex helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts -t "classifies a Codex"`
Expected: FAIL — `classifyCodexFailure` is not exported.

- [ ] **Step 3: Implement**

In `src/execution/infrastructure/runners/codex.ts`, add near `parseCodexOutput` (reusing the file's existing `parseLine`/`asRecord` helpers unchanged) and wire it into `createCodexRunner`:

```ts
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, api key, not logged
// in, login required) are NOT included here — they are a different failure
// class and must not be paused-and-retried as if they were transient.
const codexQuotaPattern =
  /usage limit|rate limit|quota|too many requests|credit balance|spend limit|session limit|\b429\b/i;

export function classifyCodexFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Only ever classify from Codex's own structured error/turn.failed
  // message, never from scanning raw stdout — stdout on a failed run can
  // carry the agent's own generated text, which must never be
  // pattern-matched into a false quota classification.
  const structured = extractCodexErrorMessage(input.stdout);
  if (structured === undefined) return undefined;
  if (!codexQuotaPattern.test(structured)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: structured };
}

function extractCodexErrorMessage(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const event = parseLine(trimmed);
    if (event === undefined) continue;
    if (event.type === 'error' && typeof event.message === 'string') return event.message;
    if (event.type === 'turn.failed') {
      const error = asRecord(event.error);
      if (typeof error?.message === 'string') return error.message;
    }
  }
  return undefined;
}
```

Update `createCodexRunner` to pass `classifyFailure: classifyCodexFailure` alongside the existing `parseSuccessfulOutput: parseCodexOutput` in the options object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/infrastructure/runners/codex.ts test/integration/execution/process-execution.test.ts
git commit -m "feat(execution): classify Codex usage-limit failures as provider-quota-exceeded"
```

---

### Task 3: Claude quota classifier

**Files:**
- Modify: `src/execution/infrastructure/runners/claude.ts`
- Test: `test/integration/execution/process-execution.test.ts`

**Interfaces:**
- Produces: `classifyClaudeFailure(input: { readonly stdout: string; readonly stderr: string }): { readonly kind: string; readonly message: string } | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
it('classifies a Claude rate-limit message as provider-quota-exceeded', () => {
  expect(
    classifyClaudeFailure({ stdout: '', stderr: 'Error: You have exceeded your rate limit. Please try again later.' }),
  ).toEqual({
    kind: 'provider-quota-exceeded',
    message: 'Error: You have exceeded your rate limit. Please try again later.',
  });
});

it('does not classify an ordinary Claude crash as quota-exceeded', () => {
  expect(classifyClaudeFailure({ stdout: '', stderr: 'ENOENT: command not found' })).toBeUndefined();
});

it('does not classify an auth failure as quota-exceeded', () => {
  expect(
    classifyClaudeFailure({ stdout: '', stderr: 'Error: Unauthorized. Please run `claude login`.' }),
  ).toBeUndefined();
});

it('does not scan stdout when stderr already carries diagnostic text', () => {
  // stdout here is agent-generated content that happens to contain "quota";
  // since stderr is non-empty it must be the only text classified against.
  expect(
    classifyClaudeFailure({
      stdout: 'I updated the quota-check middleware and committed.',
      stderr: 'ENOENT: command not found',
    }),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts -t "classifies a Claude"`
Expected: FAIL — `classifyClaudeFailure` is not exported.

- [ ] **Step 3: Implement**

In `src/execution/infrastructure/runners/claude.ts`, add (near `parseClaudeOutput`) and wire into `createClaudeRunner`:

```ts
// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, permission denied, api
// key) are NOT included here — they are a different failure class and must
// not be paused-and-retried as if they were transient.
const claudeQuotaPattern =
  /rate limit|quota|credit balance|spend limit|usage limit|session limit|too many requests|\b429\b/i;

export function classifyClaudeFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Prefer stderr — a CLI's own diagnostic stream — over stdout, which on a
  // failed run can carry the agent's own generated text; only fall back to
  // stdout when stderr is empty.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!claudeQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
}
```

Update `createClaudeRunner` to pass `classifyFailure: classifyClaudeFailure`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/infrastructure/runners/claude.ts test/integration/execution/process-execution.test.ts
git commit -m "feat(execution): classify Claude rate-limit failures as provider-quota-exceeded"
```

---

### Task 4: Cursor quota classifier

**Files:**
- Modify: `src/execution/infrastructure/runners/cursor.ts`
- Test: `test/integration/execution/process-execution.test.ts`

**Interfaces:**
- Produces: `classifyCursorFailure(input: { readonly stdout: string; readonly stderr: string }): { readonly kind: string; readonly message: string } | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
it('classifies a Cursor quota message as provider-quota-exceeded', () => {
  expect(
    classifyCursorFailure({ stdout: 'You have exceeded your monthly quota.', stderr: '' }),
  ).toEqual({ kind: 'provider-quota-exceeded', message: 'You have exceeded your monthly quota.' });
});

it('does not classify an ordinary Cursor crash as quota-exceeded', () => {
  expect(classifyCursorFailure({ stdout: '', stderr: 'panic: runtime error' })).toBeUndefined();
});

it('does not classify an auth failure as quota-exceeded', () => {
  expect(
    classifyCursorFailure({ stdout: '', stderr: 'Error: unauthorized. Invalid API key.' }),
  ).toBeUndefined();
});

it('does not scan stdout when stderr already carries diagnostic text', () => {
  expect(
    classifyCursorFailure({
      stdout: 'You have exceeded your monthly quota.',
      stderr: 'panic: runtime error',
    }),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts -t "classifies a Cursor"`
Expected: FAIL — `classifyCursorFailure` is not exported.

- [ ] **Step 3: Implement**

In `src/execution/infrastructure/runners/cursor.ts`, add and wire into `createCursorRunner` the same way as Task 3:

```ts
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, api key) are NOT
// included here — they are a different failure class and must not be
// paused-and-retried as if they were transient.
const cursorQuotaPattern =
  /rate limit|usage limit|quota|credit balance|spend limit|session limit|too many requests|\b429\b/i;

export function classifyCursorFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Prefer stderr over stdout, same reasoning as Claude's classifier: stdout
  // on a failed run can carry the agent's own generated text.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!cursorQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
}
```

Add `classifyFailure: classifyCursorFailure` to the options object `cursor.ts` passes into the shared `cliRunner` (same call shape as `codex.ts`/`claude.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/infrastructure/runners/cursor.ts test/integration/execution/process-execution.test.ts
git commit -m "feat(execution): classify Cursor quota failures as provider-quota-exceeded"
```

---

### Task 5: Typed `NoEligibleRunnerError`

**Files:**
- Modify: `src/execution/infrastructure/runners/registry.ts`
- Test: `test/unit/execution/runner-registry.test.ts`

**Interfaces:**
- Produces: `export class NoEligibleRunnerError extends Error` (re-exported via `src/execution/index.ts`'s existing `export * from './infrastructure/runners/registry.js'`).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/runner-registry.test.ts` (alongside the existing "throws a distinct error" test, which stays unchanged):

```ts
it('throws NoEligibleRunnerError, not a plain Error, when every candidate is ineligible', () => {
  const sonnet = fakeRunner();
  const codexMini = fakeRunner();
  const registry = new RunnerRegistry(
    { standard: ['sonnet', 'codex-mini'] },
    { sonnet, 'codex-mini': codexMini },
  );

  expect(() => registry.resolve('standard', new Set(['sonnet', 'codex-mini']))).toThrow(
    NoEligibleRunnerError,
  );
});
```

Add `NoEligibleRunnerError` to the file's existing `import { RunnerRegistry, type Runner } from '../../../src/execution/index.js';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/runner-registry.test.ts -t "NoEligibleRunnerError"`
Expected: FAIL — `NoEligibleRunnerError` is not exported.

- [ ] **Step 3: Implement**

In `src/execution/infrastructure/runners/registry.ts`, add the class and throw it instead of a plain `Error`:

```ts
import type { Runner } from '../../contracts/runner.js';

export class NoEligibleRunnerError extends Error {
  constructor(public readonly runnerPool: string) {
    super(`Execution runner pool ${runnerPool} has no eligible runner: all candidates are ineligible`);
    this.name = 'NoEligibleRunnerError';
  }
}

export class RunnerRegistry {
  constructor(
    private readonly runnerPools: Readonly<Record<string, readonly string[]>>,
    private readonly runners: Readonly<Record<string, Runner>>,
  ) {}

  resolve(
    runnerPool: string,
    ineligible: ReadonlySet<string> = new Set(),
  ): { readonly name: string; readonly runner: Runner } {
    const candidates = this.runnerPools[runnerPool];
    if (candidates === undefined)
      throw new Error(`Execution runner pool ${runnerPool} has no runner`);
    return selectEligibleCandidate(runnerPool, candidates, this.runners, ineligible);
  }
}

function selectEligibleCandidate(
  runnerPool: string,
  candidates: readonly string[],
  runners: Readonly<Record<string, Runner>>,
  ineligible: ReadonlySet<string>,
): { readonly name: string; readonly runner: Runner } {
  for (const name of candidates) {
    if (ineligible.has(name)) continue;
    const runner = runners[name];
    if (runner === undefined) throw new Error(`Runner ${name} is not registered`);
    return { name, runner };
  }
  throw new NoEligibleRunnerError(runnerPool);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/runner-registry.test.ts`
Expected: PASS, including the pre-existing `/no eligible runner/i` message-based test (the message is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/execution/infrastructure/runners/registry.ts test/unit/execution/runner-registry.test.ts
git commit -m "feat(execution): throw a typed NoEligibleRunnerError on full pool exhaustion"
```

---

### Task 6: `ActivityFailureCode.RunnerQuotaExceeded` and `agentOutcome()` tagging

**Files:**
- Modify: `src/activities/contracts/vocabulary.ts:48-53`
- Modify: `src/activities/agent/agent-result.ts:20-25`
- Modify: `src/activities/agent/agent-activity.ts:399-416`
- Test: `test/unit/activities/agent-result.test.ts`
- Test: `test/unit/activities/agent-activity.test.ts`

**Interfaces:**
- Consumes: `ProviderQuotaExceededFailureKind` (Task 1, from `execution`'s public surface — but `activities` must not import `execution`; see Step 3, it compares against the runner result's `failure.kind` string value directly since `AgentRunnerPort`'s `failure.kind` contract in `activities/contracts` is already an open string field, not an import of execution's constant).
- Produces: `ActivityFailureCode.RunnerQuotaExceeded = 'runner-quota-exceeded'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/activities/agent-result.test.ts` (find the existing test asserting the `failedReason` schema accepts `RunnerFailed` and add a sibling):

```ts
it('accepts a runner-quota-exceeded failed reason', () => {
  const parsed = agentActivityOutcomeSchema.parse({
    kind: 'failed',
    data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
  });
  expect(parsed).toEqual({
    kind: 'failed',
    data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
  });
});
```

Add to `test/unit/activities/agent-activity.test.ts`, matching the file's existing style exactly (see e.g. the `'swallows capture failures...'` test, which drives `createAgentActivity()` and its `invocation(...)` helper the same way):

```ts
it('tags a provider-quota-exceeded runner failure with the runner-quota-exceeded reason', async () => {
  const activity = createAgentActivity();

  const outcome = await activity.execute(invocation({ prompt: 'Prompt' }), {
    signal: new AbortController().signal,
    occurredAt: '2026-08-19T10:00:00.000Z',
    runId: 'run-123',
    runnerContext: { runnerName: 'configured-codex', runnerCli: 'codex', activationOrdinal: 1 },
    runner: {
      async start() {
        return {
          result: Promise.resolve({
            transport: 'failed' as const,
            output: '',
            runner: 'codex',
            failure: { kind: 'provider-quota-exceeded', message: "You've hit your usage limit." },
          }),
        };
      },
    },
    async reportExternalExecution() {},
  });

  expect(outcome).toEqual({
    kind: 'failed',
    data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
  });
});
```

`createAgentActivity`, `invocation`, and `activationId` etc. are already imported at the top of this file — no new imports are needed for this test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/activities/agent-result.test.ts test/unit/activities/agent-activity.test.ts -t "runner-quota-exceeded"`
Expected: FAIL — `runner-quota-exceeded` is not a recognized `ActivityFailureCode`, and `agentOutcome()` still reports `reason: 'runner-failed'` for every non-succeeded transport.

- [ ] **Step 3: Implement**

In `src/activities/contracts/vocabulary.ts`, extend `ActivityFailureCode`:

```ts
export const ActivityFailureCode = defineClosedVocabulary({
  IntentWriteFailed: 'intent-write-failed',
  InvalidAgentResult: 'invalid-agent-result',
  AmbiguousRunnerResult: 'ambiguous-runner-result',
  RunnerFailed: 'runner-failed',
  RunnerQuotaExceeded: 'runner-quota-exceeded',
} as const);
```

In `src/activities/agent/agent-result.ts`, extend the `failedReason` schema's enum:

```ts
const failedReason = z
  .object({
    reason: z.enum([
      ActivityFailureCode.InvalidAgentResult,
      ActivityFailureCode.RunnerFailed,
      ActivityFailureCode.RunnerQuotaExceeded,
    ]),
    message: z.string().optional(),
  })
  .strict();
```

In `src/activities/agent/agent-activity.ts`, replace the transport-failure branch of `agentOutcome()` (lines 407-414):

```ts
if (result.transport !== ActivityRunnerTransportStatus.Succeeded)
  return {
    kind: ActivityOutcomeKind.Failed,
    data: {
      reason:
        result.failure?.kind === 'provider-quota-exceeded'
          ? ActivityFailureCode.RunnerQuotaExceeded
          : ActivityFailureCode.RunnerFailed,
      ...(result.failure === undefined ? {} : { message: result.failure.message }),
    },
  };
```

Note: `'provider-quota-exceeded'` is written as a literal here rather than importing `execution`'s `ProviderQuotaExceededFailureKind` constant, because `activities` sits below `execution` in the module dependency order (`kernel → persistence → work → resources → activities → orchestration → execution → ...`) and must not import it. `AgentRunnerPort['start']`'s result type (defined in `activities/contracts`) already declares `failure?: { readonly kind: string; readonly message: string }` as an open string per the existing runner contract convention — this file is the one place that interprets that open string, exactly as it already does for the transport/ambiguous checks above it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/activities/agent-result.test.ts test/unit/activities/agent-activity.test.ts`
Expected: PASS, including all pre-existing tests (the `RunnerFailed` path is unchanged for any other failure kind).

- [ ] **Step 5: Commit**

```bash
git add src/activities/contracts/vocabulary.ts src/activities/agent/agent-result.ts src/activities/agent/agent-activity.ts test/unit/activities/agent-result.test.ts test/unit/activities/agent-activity.test.ts
git commit -m "feat(activities): tag provider-quota-exceeded runner failures distinctly"
```

---

### Task 7: Orchestration event type and pure `runner-quota-retry-policy` decision

**Files:**
- Modify: `src/orchestration/contracts/events.ts`
- Modify: `src/orchestration/domain/workflow-instance-events.ts`
- Create: `src/orchestration/domain/runner-quota-retry-policy.ts`
- Modify: `src/orchestration/domain/interpreter.ts`
- Test: `test/unit/orchestration/runner-quota-retry-policy.test.ts`

**Interfaces:**
- Consumes: `stateDraft`, `activation`, `nextOrdinal` from `src/orchestration/domain/decision-events.ts`; `DecisionContext`, `OrchestrationDecision` from `src/orchestration/domain/activation-policy.ts`.
- Produces: `OrchestrationEventType.ActivityRetriedForRunnerQuota`; `isRunnerQuotaRetryEligible(view: WorkflowInstanceView, activationId: string): boolean`; `requestRunnerQuotaRetry(definition: CompiledWorkflow, state: WorkflowInstanceView, input: RunnerQuotaRetryRequest): OrchestrationDecision`; type `RunnerQuotaRetryRequest`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/orchestration/runner-quota-retry-policy.test.ts`, following the exact fixture style of `test/unit/orchestration/operator-retry-policy.test.ts` (a `compileWorkflow`'d single-stage workflow via `ActivityRegistry`, `startInstance`, `foldWorkflowInstance`):

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activationId, activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { WorkflowStatus } from '../../../src/orchestration/contracts/vocabulary.js';
import {
  compileWorkflow,
  foldWorkflowInstance,
  isRunnerQuotaRetryEligible,
  OrchestrationEventType,
  requestRunnerQuotaRetry,
  startInstance,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

function fixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({ attempt: z.literal('quota') }).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'agent',
    handler: { async execute() { return { kind: 'done' }; } },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: { attempt: 'quota' },
          execution: { runnerPool: 'standard' },
          on: { done: { then: 'done' } },
        },
      },
    },
    activities,
  );
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-1'),
    workItemId: workId('1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    definition,
    occurredAt: '2026-08-19T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  const state = foldWorkflowInstance(started.events);
  return { definition, state, startEvents: started.events };
}

describe('runner-quota-retry-policy', () => {
  it('is eligible when the workflow has a matching, not-yet-accepted pending activation', () => {
    const { state } = fixture();
    expect(isRunnerQuotaRetryEligible(state, state.pendingActivation!.activationId)).toBe(true);
  });

  it('is not eligible for a different activation id', () => {
    const { state } = fixture();
    expect(isRunnerQuotaRetryEligible(state, activationId('other-activation'))).toBe(false);
  });

  it('appends a resolution fact and a fresh ActivityRequested without RetryCounted', () => {
    const { definition, state, startEvents } = fixture();
    const pendingActivationId = state.pendingActivation!.activationId;
    const decision = requestRunnerQuotaRetry(definition, state, {
      activationId: pendingActivationId,
      runId: 'run-1',
      runnerName: 'codex',
      message: "You've hit your usage limit.",
      occurredAt: '2026-08-19T12:05:00.000Z',
      causationId: 'command-1',
    });
    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') throw new Error('expected append');
    expect(decision.events.map((event) => event.eventType)).toEqual([
      OrchestrationEventType.ActivityRetriedForRunnerQuota,
      OrchestrationEventType.ActivityRequested,
    ]);

    const next = foldWorkflowInstance([...startEvents, ...decision.events]);
    expect(next.status).toBe(WorkflowStatus.Active);
    expect(next.acceptedOutcomes).toContain(pendingActivationId);
    expect(next.retryCounts).toEqual({});
    expect(next.pendingActivation?.activationId).not.toBe(pendingActivationId);
  });

  it('is ignored when the activation id no longer matches the pending activation', () => {
    const { definition, state } = fixture();
    const decision = requestRunnerQuotaRetry(definition, state, {
      activationId: activationId('stale-activation'),
      runId: 'run-1',
      runnerName: 'codex',
      message: 'stale',
      occurredAt: '2026-08-19T12:05:00.000Z',
      causationId: 'command-1',
    });
    expect(decision.kind).toBe('ignored');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/orchestration/runner-quota-retry-policy.test.ts`
Expected: FAIL — module `runner-quota-retry-policy.js` does not exist; `isRunnerQuotaRetryEligible`/`requestRunnerQuotaRetry`/`OrchestrationEventType.ActivityRetriedForRunnerQuota` are not exported.

- [ ] **Step 3: Implement**

In `src/orchestration/contracts/events.ts`, add the event type constant (alongside `ActivityExecutionFailed`):

```ts
export const OrchestrationEventType = {
  // ...unchanged members...
  ActivityExecutionFailed: 'orchestration.activity-execution-failed',
  ActivityRetriedForRunnerQuota: 'orchestration.activity-retried-for-runner-quota',
  // ...remaining unchanged members...
} as const;
```

Add its payload type to `OrchestrationEventPayloads` (alongside `ActivityExecutionFailed`'s):

```ts
readonly [OrchestrationEventType.ActivityRetriedForRunnerQuota]: {
  readonly activationId: ActivationId;
  readonly runId: string;
  readonly runnerName: string;
  readonly message: string;
};
```

In `src/orchestration/domain/workflow-instance-events.ts`:
- Add `typeof OrchestrationEventType.ActivityRetriedForRunnerQuota` to the `ActivityFact` union (line 68-75) and to `isActivityFact`'s switch (line 105-117).
- Add a case in `applyActivityFact` (after the `ActivityExecutionFailed` case, line 135-139):

```ts
case OrchestrationEventType.ActivityRetriedForRunnerQuota:
  state.acceptedOutcomes.push(event.payload.activationId);
  updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Completed);
  return;
```

Create `src/orchestration/domain/runner-quota-retry-policy.ts`:

```ts
import type { CompiledWorkflow } from '../contracts/config.js';
import { OrchestrationEventType, type WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { DecisionContext, OrchestrationDecision } from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export interface RunnerQuotaRetryRequest extends DecisionContext {
  readonly activationId: string;
  readonly runId: string;
  readonly runnerName: string;
  readonly message: string;
}

export function isRunnerQuotaRetryEligible(
  view: WorkflowInstanceView,
  activationId: string,
): boolean {
  return (
    view.pendingActivation?.activationId === activationId &&
    !view.acceptedOutcomes.includes(activationId)
  );
}

export function requestRunnerQuotaRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: RunnerQuotaRetryRequest,
): OrchestrationDecision {
  if (!isRunnerQuotaRetryEligible(state, input.activationId))
    return {
      kind: 'ignored',
      reason: 'workflow has no matching pending activation for runner-quota retry',
    };
  const stage = definition.stages[stageName(state.currentStage)]!;
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRetriedForRunnerQuota,
      {
        activationId: input.activationId,
        runId: input.runId,
        runnerName: input.runnerName,
        message: input.message,
      },
      1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
        stage: stageName(state.currentStage),
      }),
      2,
    ),
  ];
  return { kind: 'append', events };
}
```

In `src/orchestration/domain/interpreter.ts`, add a re-export block (mirroring the `operator-retry-policy.ts` block at lines 40-48):

```ts
export { isRunnerQuotaRetryEligible, requestRunnerQuotaRetry } from './runner-quota-retry-policy.js';

export type { RunnerQuotaRetryRequest } from './runner-quota-retry-policy.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/orchestration/runner-quota-retry-policy.test.ts`
Expected: PASS.

Then run the full orchestration unit suite to confirm no regression from the `ActivityFact` union / event-type additions:
Run: `npx vitest run test/unit/orchestration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/contracts/events.ts src/orchestration/domain/workflow-instance-events.ts src/orchestration/domain/runner-quota-retry-policy.ts src/orchestration/domain/interpreter.ts test/unit/orchestration/runner-quota-retry-policy.test.ts
git commit -m "feat(orchestration): add runner-quota transparent retry decision"
```

---

### Task 8: `AdvanceWorkflow.retryRunnerQuotaFailure` and service wiring

**Files:**
- Modify: `src/orchestration/application/advance-workflow.ts`
- Modify: `src/orchestration/application/orchestration-service.ts`
- Test: Create `test/unit/orchestration/runner-quota-retry-service.test.ts`

**Interfaces:**
- Consumes: `requestRunnerQuotaRetry` (Task 7, imported from `../domain/interpreter.js`).
- Produces: `AdvanceWorkflow.retryRunnerQuotaFailure(id, input, context): Promise<WorkflowInstanceView | null>`; `OrchestrationService.retryRunnerQuotaFailure(workflowInstanceId, input, context)` (same signature, delegates through `transitionWatchChildren`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/orchestration/runner-quota-retry-service.test.ts`, mirroring `test/unit/orchestration/operator-retry-service.test.ts`'s exact `OrchestrationService`-against-a-real-journal construction (that file's `blockedWorkflow()` helper, minus its final `acceptOutcome({ outcome: { kind: 'failed' } })` step, since a runner-quota retry acts on a still-pending activation, not one that has already failed):

```ts
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string, occurredAt = '2026-08-19T12:00:00Z') => ({
  commandId,
  correlationId: correlationId('runner-quota-retry-correlation'),
  occurredAt,
  actor: { kind: 'system' as const, id: 'control-plane' },
});

async function startedWorkflow() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workId('runner-quota-retry'), objective: 'retry after quota' },
    context('work'),
  );
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' as const };
      },
    },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    },
    registry,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const instance = await service.start(
    {
      workflowInstanceId: workflowInstanceId('runner-quota-retry-workflow'),
      workItemId: workId('runner-quota-retry'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('runner-quota-retry-group'),
    },
    context('start'),
  );
  return { service, instance };
}

it('resolves the pending activation and requests a fresh one without publishing a workflow outcome', async () => {
  const { service, instance } = await startedWorkflow();
  const pendingActivationId = instance.pendingActivation!.activationId;

  const result = await service.retryRunnerQuotaFailure(
    instance.workflowInstanceId,
    {
      activationId: pendingActivationId,
      runId: 'run-1',
      runnerName: 'codex',
      message: 'usage limit hit',
    },
    context('quota-retry-1'),
  );

  expect(result?.acceptedOutcomes).toContain(pendingActivationId);
  expect(result?.pendingActivation?.activationId).not.toBe(pendingActivationId);
  expect(result?.retryCounts).toEqual({});
  expect(result?.lastOutcome).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/orchestration/runner-quota-retry-service.test.ts`
Expected: FAIL — `service.retryRunnerQuotaFailure` is not a function.

- [ ] **Step 3: Implement**

In `src/orchestration/application/advance-workflow.ts`, add the import and method (after `resolveExecutionFailure`, before `retryBlockedFailedStage`):

```ts
import { requestRunnerQuotaRetry } from '../domain/interpreter.js';
```

```ts
async retryRunnerQuotaFailure(
  id: WorkflowInstanceId,
  input: {
    readonly activationId: ActivationId;
    readonly runId: string;
    readonly runnerName: string;
    readonly message: string;
  },
  context: CommandContext,
) {
  const loaded = await this.repository.load(id);
  if (loaded.view === null) return null;
  const definition = await this.workflows.definitionForOperation(
    loaded.view,
    loaded.sequence,
    context,
  );
  if (definition === null) return (await this.repository.loadRequired(id)).view;
  const decision = requestRunnerQuotaRetry(definition, loaded.view, {
    activationId: input.activationId,
    runId: input.runId,
    runnerName: input.runnerName,
    message: input.message,
    occurredAt: context.occurredAt,
    causationId: context.commandId,
  });
  if (decision.kind === 'ignored') return loaded.view;
  await this.repository.append(id, loaded.sequence, decision.events);
  return (await this.repository.load(id)).view;
}
```

In `src/orchestration/application/orchestration-service.ts`, add a delegating wrapper (after `resolveExecutionFailure`, before `retryBlockedFailedStage`):

```ts
retryRunnerQuotaFailure(
  workflowInstanceId: WorkflowInstanceId,
  input: {
    readonly activationId: ActivationId;
    readonly runId: string;
    readonly runnerName: string;
    readonly message: string;
  },
  context: CommandContext,
) {
  return this.transitionWatchChildren(context, () =>
    this.advanceWorkflow.retryRunnerQuotaFailure(workflowInstanceId, input, context),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/orchestration/runner-quota-retry-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/application/advance-workflow.ts src/orchestration/application/orchestration-service.ts test/unit/orchestration/runner-quota-retry-service.test.ts
git commit -m "feat(orchestration): wire retryRunnerQuotaFailure through OrchestrationService"
```

---

### Task 9: Intercept quota outcomes in the control-plane dispatch loop

**Files:**
- Modify: `src/control-plane/application/advance-once-ports.ts`
- Modify: `src/control-plane/application/advance-once-dispatch.ts`
- Test: `test/unit/control-plane/advance-once.test.ts`

**Interfaces:**
- Consumes: `OrchestrationService.retryRunnerQuotaFailure` (Task 8) via the `OrchestrationPort` interface; `ActivityFailureCode`, `ActivityOutcomeKind` from `../../activities/index.js`.
- Produces: `OrchestrationPort.retryRunnerQuotaFailure?(workflowInstanceId, input, context): Promise<WorkflowInstanceView | null>`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/control-plane/advance-once.test.ts`, following the exact style of the existing `'resolves a failed Run in orchestration before reporting it as blocked'` test (hand-rolled `OrchestrationPort`/`ExecutionPort` fakes):

```ts
it('retries a quota-exceeded outcome through orchestration instead of accepting it', async () => {
  const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
  const workflow = {
    workflowInstanceId: 'workflow-1',
    workItemId: 'work-1',
    orchestrationGroupId: 'group-1',
    acceptedOutcomes: [],
  } as unknown as WorkflowInstanceView;
  const accepted: unknown[] = [];
  const retried: unknown[] = [];
  const advance = createAdvanceOnce(
    {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () => [{ workflow, activation }],
      listWaiting: async () => [],
      acceptOutcome: async (...input: unknown[]) => {
        accepted.push(input);
        return workflow;
      },
      markActivationStarted: async () => workflow,
      retryRunnerQuotaFailure: async (...input: unknown[]) => {
        retried.push(input);
        return workflow;
      },
    } as never,
    {
      attempt: async () =>
        ({
          runId: 'run-1',
          status: 'succeeded',
          runner: { name: 'codex' },
          outcome: {
            kind: 'failed',
            data: { reason: 'runner-quota-exceeded', message: "You've hit your usage limit." },
          },
        }) as never,
      list: async () => [],
    },
    { correlationsForWork: async () => [] } as never,
    { now: () => new Date('2026-08-19T00:00:00.000Z') },
    { ids: { next: () => 'command-1' } as never },
  );

  await advance({ maxProgress: 1 });

  expect(accepted).toEqual([]);
  expect(retried).toEqual([
    [
      workflow.workflowInstanceId,
      {
        activationId: activation.activationId,
        runId: 'run-1',
        runnerName: 'codex',
        message: "You've hit your usage limit.",
      },
      expect.anything(),
    ],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/control-plane/advance-once.test.ts -t "retries a quota-exceeded outcome"`
Expected: FAIL — the dispatch loop calls `acceptOutcome` unconditionally, so `accepted` is non-empty and `retried` stays empty.

- [ ] **Step 3: Implement**

In `src/control-plane/application/advance-once-ports.ts`, add the optional method to `OrchestrationPort` (after `resolveExecutionFailure`):

```ts
retryRunnerQuotaFailure?(
  workflowInstanceId: string,
  input: {
    readonly activationId: string;
    readonly runId: string;
    readonly runnerName: string;
    readonly message: string;
  },
  context: CommandContext,
): Promise<WorkflowInstanceView | null>;
```

In `src/control-plane/application/advance-once-dispatch.ts`, add the import and helpers, and replace the outcome-acceptance block:

```ts
import { ActivityFailureCode, ActivityOutcomeKind, type ActivityOutcome } from '../../activities/index.js';
```

```ts
function isRunnerQuotaOutcome(outcome: ActivityOutcome): boolean {
  return (
    outcome.kind === ActivityOutcomeKind.Failed &&
    typeof outcome.data === 'object' &&
    outcome.data !== null &&
    'reason' in outcome.data &&
    (outcome.data as { reason?: unknown }).reason === ActivityFailureCode.RunnerQuotaExceeded
  );
}

function runnerQuotaMessage(outcome: ActivityOutcome): string {
  const data = outcome.data as { message?: unknown };
  return typeof data.message === 'string' ? data.message : 'runner reported quota exhaustion';
}
```

Replace lines 130-143 (the `if (run.status === RunStatus.Succeeded && run.outcome !== undefined) { ... }` block):

```ts
if (run.status === RunStatus.Succeeded && run.outcome !== undefined) {
  if (isRunnerQuotaOutcome(run.outcome)) {
    await ctx.orchestration.retryRunnerQuotaFailure?.(
      selected.workflow.workflowInstanceId,
      {
        activationId: selected.activation.activationId,
        runId: run.runId,
        runnerName: run.runner?.name ?? 'unknown-runner',
        message: runnerQuotaMessage(run.outcome),
      },
      ctx.commandContext(run.runId),
    );
  } else {
    if (await ctx.isDispatchPaused()) {
      stopReason = { kind: 'paused' };
      break;
    }
    await ctx.orchestration.acceptOutcome(
      {
        workflowInstanceId: selected.workflow.workflowInstanceId,
        activationId: selected.activation.activationId,
        outcome: run.outcome,
      },
      ctx.commandContext(run.runId),
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/control-plane/advance-once.test.ts`
Expected: PASS, including all pre-existing tests in the file (the non-quota `acceptOutcome` path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/control-plane/application/advance-once-ports.ts src/control-plane/application/advance-once-dispatch.ts test/unit/control-plane/advance-once.test.ts
git commit -m "feat(control-plane): retry runner-quota outcomes instead of accepting them"
```

---

### Task 10: Catch `NoEligibleRunnerError` in the dispatch loop

**Files:**
- Modify: `src/control-plane/application/advance-once-dispatch.ts`
- Test: `test/unit/control-plane/advance-once.test.ts`

**Interfaces:**
- Consumes: `NoEligibleRunnerError` (Task 5, from `../../execution/index.js`, alongside the file's existing `ActivationClaimConflictError` import).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/control-plane/advance-once.test.ts`:

```ts
it('stops the dispatch loop for this tick, without crashing, when every pool runner is ineligible', async () => {
  const activation = { activationId: 'activation-1' } as unknown as ActivityActivationView;
  const workflow = {
    workflowInstanceId: 'workflow-1',
    workItemId: 'work-1',
    orchestrationGroupId: 'group-1',
    acceptedOutcomes: [],
  } as unknown as WorkflowInstanceView;
  const advance = createAdvanceOnce(
    {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () => [{ workflow, activation }],
      listWaiting: async () => [],
      acceptOutcome: async () => workflow,
      markActivationStarted: async () => workflow,
    } as never,
    {
      attempt: async () => {
        throw new NoEligibleRunnerError('standard');
      },
      list: async () => [],
    },
    { correlationsForWork: async () => [] } as never,
    { now: () => new Date('2026-08-19T00:00:00.000Z') },
    { ids: { next: () => 'command-1' } as never },
  );

  await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'no-work' });
});
```

Add `NoEligibleRunnerError` to the test file's existing import from `'../../../src/execution/index.js'` (or add a new import line if the file does not already import from there).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/control-plane/advance-once.test.ts -t "stops the dispatch loop for this tick"`
Expected: FAIL — the thrown `NoEligibleRunnerError` propagates out of `advance()` and rejects the promise instead of resolving to `{ kind: 'no-work' }`.

- [ ] **Step 3: Implement**

In `src/control-plane/application/advance-once-dispatch.ts`, add `NoEligibleRunnerError` to the existing import from `'../../execution/index.js'`:

```ts
import { ActivationClaimConflictError, NoEligibleRunnerError, RunStatus, WorkspaceMode } from '../../execution/index.js';
```

Extend the existing catch block around `ctx.execution.attempt(...)`:

```ts
} catch (error) {
  if (error instanceof ActivationClaimConflictError) {
    stopReason = { kind: 'no-work' };
    break;
  }
  if (error instanceof NoEligibleRunnerError) {
    stopReason = { kind: 'no-work' };
    break;
  }
  throw error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/control-plane/advance-once.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/control-plane/application/advance-once-dispatch.ts test/unit/control-plane/advance-once.test.ts
git commit -m "fix(control-plane): stop the dispatch loop gracefully when a runner pool is fully exhausted"
```

---

### Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the fast local verification gate**

Run: `npm run verify`
Expected: PASS — this covers `lint`, `lint:architecture`, `format:check`, `check:catalogue`, `check:scenarios`, and `test:fast` (confirm the exact composition by reading `package.json`'s `verify` script if it differs from this list; report any deviation rather than assuming).

- [ ] **Step 2: Run the full non-live CI gate**

Run: `npm run verify:ci`
Expected: PASS — additionally covers `test:integration`, `test:e2e`, and `test:web`. This is the point at which any missed module-boundary violation (e.g. `activities` accidentally importing from `execution`, caught by `lint:architecture`) or spec-drift (`check:specs`) surfaces.

- [ ] **Step 3: Sync module specs**

The changed modules (`execution`, `activities`, `orchestration`, `control-plane`) each carry `SPEC.md`/`*.spec.md` files describing current behavior (per `AGENTS.md`: "Read the target module's `MODULE.md`, `module.json`, public `index.ts`, and its relevant contracts before changing it"). Run:

Run: `npm run check:specs`

If it reports any of these four modules as stale, invoke the `sync-module-specs` skill to bring them up to date with the new `provider-quota-exceeded` classification path, the `ActivityFailureCode.RunnerQuotaExceeded` outcome tag, and the `retryRunnerQuotaFailure` orchestration operation — do not hand-write spec prose outside that skill's workflow.

- [ ] **Step 4: Manual smoke check (no live provider calls required)**

Confirm the end-to-end wiring by tracing one scenario without running a real CLI: with a runner pool of two Codex-kind entries, a Run whose stdout is the exact JSONL transcript from the original bug report should — after Tasks 1–10 — produce `failure.kind: 'provider-quota-exceeded'` (Task 2), an `ActivityFailureCode.RunnerQuotaExceeded`-tagged outcome (Task 6), a `retryRunnerQuotaFailure` call instead of `acceptOutcome` (Task 9), a `RunnerPaused` control-plane fact for that runner name (pre-existing, `execution-activity.ts:150`/`runner-quota-reporter.ts`, unchanged), and a fresh `ActivityRequested` for the same stage with no `RetryCounted` (Task 7/8). If `test:fast`/`test:integration` all pass, this chain is exercised piecewise by Tasks 1–10's tests; no additional live-provider smoke run is required for this plan to be considered complete.

- [ ] **Step 5: Report**

Report to the user: which of `verify`/`verify:ci`/`check:specs` were run and their outcome, and explicitly restate that full-pool-exhaustion visibility (a new `WorkflowStatus` and auto-resuming dispatch candidate query) is deferred to a follow-on plan per the design doc, so it isn't mistaken for done.

# Transcript Capture and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide opt-in, filesystem-only prompt/response transcript capture, 24-hour post-close retention, and a work-item chat-style transcript UI.

**Architecture:** Execution records raw prompt/response artifacts through a small transcript store, never through journal events or projections. Durable Run metadata indexes artifacts by work item, runner CLI, run ID, and returned session ID; API applications assemble standard transcript groups for all CLIs, and the web surface renders that standard shape.

**Tech Stack:** TypeScript, Zod, Node.js filesystem promises, Vitest, existing API surface, React and TanStack Query.

---

### Task 1: Add strict transcript configuration

**Files:**
- Modify: `src/bootstrap/config/root-schema.ts`
- Modify: `src/bootstrap/initialise.ts`
- Test: `test/unit/bootstrap/root-schema.test.ts`

- [ ] **Step 1: Write the failing configuration tests**

```ts
expect(parseRootConfig(baseConfig)).toMatchObject({
  transcripts: { enabled: false, retentionMs: 86_400_000 },
});
expect(() =>
  parseRootConfig({
    ...baseConfig,
    transcripts: { retainAfterWorkspaceCleanup: true },
  }),
).toThrow();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/bootstrap/root-schema.test.ts`

Expected: FAIL because `transcripts` is absent from the root configuration.

- [ ] **Step 3: Add the schema and starter configuration**

```ts
const transcriptsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    retentionMs: z.number().int().nonnegative().default(86_400_000),
  })
  .strict();
```

Compose it under the strict root schema and add this to initialised YAML:

```yaml
transcripts:
  enabled: false
  retentionMs: 86400000
```

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/unit/bootstrap/root-schema.test.ts test/integration/bootstrap/initialise.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/bootstrap/config/root-schema.ts src/bootstrap/initialise.ts test/unit/bootstrap/root-schema.test.ts test/integration/bootstrap/initialise.test.ts
git commit -m "feat: configure transcript capture"
```

### Task 2: Build a filesystem transcript store

**Files:**
- Create: `src/execution/infrastructure/transcript-store.ts`
- Modify: `src/execution/index.ts`
- Test: `test/integration/execution/transcript-store.test.ts`

- [ ] **Step 1: Write the failing storage tests**

Prove session grouping, run fallback, lexical timestamp ordering, and cleanup marking:

```text
transcripts/work-1/session--codex-cli--session-1/
  20260812T141503.123Z.run-1.prompt.txt
  20260812T141642.881Z.run-1.response.txt
transcripts/work-1/run--run-2/
  20260812T141700.000Z.run-2.prompt.txt
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/execution/transcript-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the standard artifact store**

Export a `TranscriptStore` with `capturePrompt`, `captureResponse`,
`listGroups`, `readGroup`, `groupForRun`, `markWorkItemCleaned`, and
`sweepExpired`. Use typed directory keys (`session--<safe-cli>--<safe-id>`
or `run--<safe-run-id>`), explicit timestamp parsing, and a filesystem-only
`.cleaned-at` marker. Never sort using mtime or append journal events.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run test/integration/execution/transcript-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/execution/infrastructure/transcript-store.ts src/execution/index.ts test/integration/execution/transcript-store.test.ts
git commit -m "feat: store transcript conversation groups"
```

### Task 3: Capture at the Agent activity boundary

**Files:**
- Modify: `src/activities/contracts/activity.ts`
- Modify: `src/activities/agent/agent-activity.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Test: `test/unit/activities/agent-activity.test.ts`
- Test: `test/integration/bootstrap/transcript-capture.test.ts`

- [ ] **Step 1: Write failing capture tests**

```ts
expect(calls).toEqual([
  { kind: 'prompt', runId: 'run-1', text: 'exact rendered prompt' },
  {
    kind: 'response',
    runId: 'run-1',
    text: 'raw runner stdout',
    sessionId: 'session-1',
  },
]);
```

Also prove disabled capture makes no files and recorder failure preserves the
agent outcome and runner-result reporting.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run test/unit/activities/agent-activity.test.ts test/integration/bootstrap/transcript-capture.test.ts`

Expected: FAIL because there is no transcript recorder port.

- [ ] **Step 3: Add and compose the optional recorder**

Add an optional recorder to the activity execution context. Record the exact
request prompt after rendering and before `runner.start`; record raw runner
output after its result resolves, with CLI identity and returned session ID.
Bootstrap supplies it only when `config.transcripts.enabled` is true. Log and
swallow recorder errors.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/unit/activities/agent-activity.test.ts test/integration/bootstrap/transcript-capture.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/activities src/bootstrap/composition-root.ts test/unit/activities/agent-activity.test.ts test/integration/bootstrap/transcript-capture.test.ts
git commit -m "feat: capture agent transcripts"
```

### Task 4: Retain after closure without transcript events

**Files:**
- Modify: `src/control-plane/application/advance-once.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Test: `test/integration/control-plane/transcript-retention.test.ts`
- Test: `test/e2e/scenarios/transcript-retention.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Prove a closed work item is marked on successful workspace cleanup, remains
readable before 86,400,000ms, and is removed at/after expiry; separately prove
`retentionMs: 0` removes it immediately. Assert neither marking nor sweeping
appends an event.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run test/integration/control-plane/transcript-retention.test.ts test/e2e/scenarios/transcript-retention.test.ts`

Expected: FAIL because no cleanup marker or sweep exists.

- [ ] **Step 3: Wire retention into maintenance**

Call the store after successful closed-workspace cleanup and invoke its sweep
from the existing maintenance pass. Isolate each filesystem failure, log it,
and continue; transcript I/O must not alter Run outcome or workspace cleanup
success.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/integration/control-plane/transcript-retention.test.ts test/e2e/scenarios/transcript-retention.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/control-plane src/bootstrap/composition-root.ts test/integration/control-plane/transcript-retention.test.ts test/e2e/scenarios/transcript-retention.test.ts
git commit -m "feat: retain transcripts after work closure"
```

### Task 5: Expose work-item and run transcript APIs

**Files:**
- Modify: `src/surfaces/api/contracts/execution.ts`
- Modify: `src/surfaces/api/routes/applications.ts`
- Modify: `src/surfaces/api/routes/read.ts`
- Modify: `src/bootstrap/surface-api-execution-applications.ts`
- Test: `test/integration/surfaces/api-transcripts.test.ts`

- [ ] **Step 1: Write failing API tests**

Test a work-item transcript-group index, selected-group conversation read, and
the existing run transcript deep link. Expect common entries:

```ts
{ occurredAt, channel: 'input' | 'agent', text, runId, groupId, durationMs?: number }
```

The index includes group kind, CLI when available, latest timestamp, and run
IDs. Missing/expired data is unavailable, never reconstructed from journal
events.

- [ ] **Step 2: Run the focused test to verify routes fail**

Run: `npx vitest run test/integration/surfaces/api-transcripts.test.ts`

Expected: FAIL because work-item transcript routes are absent.

- [ ] **Step 3: Implement read-only applications and routes**

Join requested Run views to transcript artifacts; calculate duration only when
both Run timestamps exist. Do not expose filesystem paths. The UI gets one
standard response irrespective of CLI.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test/integration/surfaces/api-transcripts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/surfaces/api src/bootstrap/surface-api-execution-applications.ts test/integration/surfaces/api-transcripts.test.ts
git commit -m "feat: expose work item transcripts"
```

### Task 6: Add the chat-style work-item transcript UI

**Files:**
- Modify: `src/surfaces/web/src/api/client.ts`
- Modify: `src/surfaces/web/src/api/decoders.ts`
- Modify: `src/surfaces/web/src/api/query-keys.ts`
- Modify: `src/surfaces/web/src/features/work/work.tsx`
- Modify: `src/surfaces/web/src/features/features.module.css`
- Test: `src/surfaces/web/test/work-detail.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert the work-item detail screen has a Transcripts group list; visually
distinct input and Agent reply cards; timestamps, source run IDs, response
duration, run separators, and a `This run only` filter. Assert multiline raw
text is literal pre-wrapped text, not Markdown or HTML.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test:web -- --run src/surfaces/web/test/work-detail.test.tsx`

Expected: FAIL because the transcript section is absent.

- [ ] **Step 3: Add the common chat renderer**

Render the API `channel` as sent-input or agent-reply cards. Keep message
text primary and metadata subdued, provide accessible group/filter controls, and
do not branch rendering by CLI.

- [ ] **Step 4: Run focused UI test and web build**

Run: `npm run test:web -- --run src/surfaces/web/test/work-detail.test.tsx`

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/surfaces/web
git commit -m "feat: render work item transcript conversations"
```

### Task 7: Update reference documentation and specifications

**Files:**
- Modify: `docs/configuration.md`
- Modify: `src/execution/SPEC.md`
- Modify: `src/execution/infrastructure/prompt-templates.spec.md`
- Modify: `src/execution/MODULE.md`

- [ ] **Step 1: Describe current behavior**

Document opt-in capture, `retentionMs` as milliseconds, default
`86400000` (24 hours), typed session/run grouping, post-close cleanup, and
work-item/API reading. Remove every current-state statement that says capture
is deferred or unwired.

- [ ] **Step 2: Check stale reference content**

Run: `rg -n "not yet wired|retentionMs: 259200000|retainAfterWorkspaceCleanup" docs src`

Expected: no stale current-state references; the rejected legacy key may appear
only in validation documentation.

- [ ] **Step 3: Commit**

```powershell
git add docs/configuration.md src/execution
git commit -m "docs: describe transcript operations"
```

### Task 8: Run scoped regressions

- [ ] **Step 1: Run focused verification**

```powershell
npx vitest run test/unit/bootstrap/root-schema.test.ts test/unit/activities/agent-activity.test.ts test/integration/execution/transcript-store.test.ts test/integration/control-plane/transcript-retention.test.ts test/integration/surfaces/api-transcripts.test.ts test/e2e/scenarios/transcript-retention.test.ts
npm run test:web
npm run build
```

Expected: PASS.

- [ ] **Step 2: Inspect final state**

```powershell
git diff --check HEAD~7..HEAD
git status --short
```

Expected: no whitespace errors and a clean worktree.

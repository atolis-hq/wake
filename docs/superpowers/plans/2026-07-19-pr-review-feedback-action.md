# PR Review Feedback Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a work item is `awaiting-approval`, a new comment arriving on the PR Wake already correlated to it (a review, a review-thread reply, or a plain PR comment) should automatically trigger a dedicated `revise` action — no `/approved`/`/changes`/`/question` slash command required — where the agent judges each comment independently and either makes the change, answers a question, or pushes back with justification.

**Architecture:** `policy-engine.ts` already gates the `awaiting-approval` state behind `resolveApprovalTransition`, which requires an explicit slash command and is correct for _issue_-thread comments (approving the merge is a real decision that needs an explicit human act). PR-sourced comments are a different signal — leaving a comment on a PR is already the deliberate act, and `commentSnapshotSchema.resourceUri` (schema.ts:143-145) already discriminates them ("absent = the originating issue thread"). This plan adds a second, narrower policy gate — `resolvePendingReviewFeedback` — that fires only when the latest unhandled comment carries a `resourceUri`, selects a new built-in action (`revise`) instead of resuming the workflow's own action, and leaves the work item in `implement`/`awaiting-approval` afterward (approval to merge is still issue-only). The prompt-building pipeline (`stage-prompt.ts`) already surfaces new comments generically by action name and already auto-replies the agent's prose response to the triggering PR/review-thread surface (`createPublishIntentEvent` in tick-runner.ts) — no changes needed there beyond a prompt file and one small formatting addition so the agent can address a second thread in the same batch.

**Tech Stack:** TypeScript, vitest, zod, Handlebars prompt templates.

## Global Constraints

- Runner prompt templates must set `maxTurns` in frontmatter (CLAUDE.md: "Any new runner invocation must set `--max-turns`") — `prompts/revise.md` must include it.
- `core/` stays a pure function of durable state; no caching "what happened last tick" in process memory (CLAUDE.md).
- The runner's only outputs are code/PR/comments plus the sentinel; Wake (policy-engine + tick-runner), not the prompt, decides stage transitions (CLAUDE.md: "Wake decides, the agent runs").
- Prefer exercising `core/` logic through existing fakes (`createFakeResourceIndex`, `createFakeWorkspaceManager`) rather than ad hoc mocks (CLAUDE.md testing conventions).
- Run `npm run verify` (build + test) before considering the branch done.

---

### Task 1: Add `resolvePendingReviewFeedback` to the policy engine

**Files:**

- Modify: `src/core/policy-engine.ts`
- Test: `test/core/policy-engine.test.ts`

**Interfaces:**

- Consumes: `IssueStateRecord` (`src/domain/types.js`), the private `isAwaitingApproval`/`latestUnhandledHumanComment` helpers already in this file.
- Produces: `createPolicyEngine().resolvePendingReviewFeedback(issue: IssueStateRecord): AgentAction | null` — returns the literal string `'revise'` when the latest unhandled human comment carries a `resourceUri` (i.e. came from a correlated PR/review-thread surface, not the issue thread), otherwise `null`. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Open `test/core/policy-engine.test.ts` and add this new `describe` block immediately after the closing `});` of `describe('policy engine: resolveApprovalTransition', ...)` (i.e. right before `describe('policy engine: needsWakeAction', ...)`):

```ts
describe('policy engine: resolvePendingReviewFeedback', () => {
  it('returns null when issue is not awaiting approval', () => {
    const policy = createPolicyEngine();
    const issue = buildIssue({ labels: ['wake'] });
    expect(policy.resolvePendingReviewFeedback(issue)).toBeNull();
  });

  it('returns null when the latest unhandled comment has no resourceUri (issue thread, not a PR surface)', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'Looks reasonable to me.',
      pendingApprovalAction: 'implement',
    });
    expect(policy.resolvePendingReviewFeedback(issue)).toBeNull();
  });

  it('returns "revise" when the latest unhandled comment came from a correlated PR surface, even without a pendingApprovalAction (legacy state)', () => {
    const policy = createPolicyEngine();
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      workItemKey: workId,
      issue: {
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-501',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-06T01:00:00.000Z',
          updatedAt: '2026-07-06T01:00:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#51/rt_501',
          reviewThread: { path: 'docs/example.md', line: 3 },
        },
      ],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-06T00:00:00.000Z',
        stageHistory: [],
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
      },
    });

    expect(policy.resolvePendingReviewFeedback(issue)).toBe('revise');
  });

  it('returns null when the latest PR-sourced comment was already handled', () => {
    const policy = createPolicyEngine();
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      workItemKey: workId,
      issue: {
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-501',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-06T01:00:00.000Z',
          updatedAt: '2026-07-06T01:00:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#51/rt_501',
        },
      ],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-06T00:00:00.000Z',
        stageHistory: [],
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        lastHandledCommentId: 'pr-review-comment-501',
      },
    });

    expect(policy.resolvePendingReviewFeedback(issue)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/policy-engine.test.ts -t "resolvePendingReviewFeedback"`
Expected: FAIL — `policy.resolvePendingReviewFeedback is not a function`.

- [ ] **Step 3: Implement `resolvePendingReviewFeedback`**

In `src/core/policy-engine.ts`, add this constant near the top of the file, right after the existing `questionCommandPattern` declaration (around line 24):

```ts
// The action Wake runs when a correlated PR gets new reviewer feedback while
// the work item is awaiting approval. Not configurable per workflow: it's a
// lateral response to a PR surface, not a workflow stage.
const reviewFeedbackAction = 'revise';
```

Then add this method to the object returned by `createPolicyEngine()`, immediately after `resolveApprovalTransition`'s closing `},` (i.e. right before `qualifiesForMint(...)`):

```ts
    resolvePendingReviewFeedback(issue: IssueStateRecord): AgentAction | null {
      if (!isAwaitingApproval(issue)) {
        return null;
      }

      const latestHumanComment = latestUnhandledHumanComment(issue);

      // resourceUri is set only on comments folded from a correlated PR/review
      // surface (schema.ts's commentSnapshotSchema: "absent = the originating
      // issue thread"). A comment on that surface is itself the deliberate
      // act — unlike an issue-thread reply, it doesn't need an explicit
      // /approved-style command to count as a decision.
      if (latestHumanComment === undefined || latestHumanComment.resourceUri === undefined) {
        return null;
      }

      return reviewFeedbackAction;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: PASS — all tests in the file, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/policy-engine.ts test/core/policy-engine.test.ts
git commit -m "policy: add resolvePendingReviewFeedback for PR-sourced review comments"
```

---

### Task 2: Wire the `revise` action into tick-runner's awaiting-approval dispatch

**Files:**

- Modify: `src/core/tick-runner.ts`
- Test: `test/core/tick-runner.test.ts`

**Interfaces:**

- Consumes: `policy.resolvePendingReviewFeedback` from Task 1.
- Produces: when a candidate is `awaiting-approval` with no slash-command resolution but a fresh PR-sourced comment, the tick runner now calls `deps.runner.run({ action: 'revise', ... })` with `claimedStage` left at the candidate's current stage, instead of returning idle.

- [ ] **Step 1: Write the failing tests**

Open `test/core/tick-runner.test.ts` and add these two tests immediately after the existing test `'stays idle when awaiting approval and the comment is conversation, not an explicit command (S2)'` (search for that string to find the end of its `it(...)` block, and insert after its closing `});`):

```ts
it('invokes the revise action (not idle) when awaiting approval and the latest unhandled comment is PR-sourced (no slash command required)', async () => {
  const store = createStateStore({ wakeRoot: root });
  let runnerCallCount = 0;
  let capturedAction: string | undefined;

  await store.writeIssueState({
    schemaVersion: 1,
    workItemKey: workId(99),
    issue: {
      repo: 'atolis-hq/wake',
      number: 99,
      title: 'Review Feedback Test',
      body: 'Body',
      labels: ['wake:queue'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/99',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:05:00.000Z',
    },
    comments: [
      {
        id: 'pr-review-comment-501',
        body: 'Rename "item" to "work item"',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_501',
        reviewThread: { path: 'docs/example.md', line: 3 },
      },
    ],
    latestComment: {
      id: 'pr-review-comment-501',
      body: 'Rename "item" to "work item"',
      author: { login: 'reviewer' },
      createdAt: '2026-07-05T12:05:00.000Z',
      updatedAt: '2026-07-05T12:05:00.000Z',
      isBotAuthored: false,
      resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_501',
      reviewThread: { path: 'docs/example.md', line: 3 },
    },
    wake: {
      stage: 'implement',
      stageHistory: [],
      recentEventIds: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {
      lastRunSentinel: 'AWAITING_APPROVAL',
      pendingApprovalAction: 'implement',
    },
    correlatedResources: [],
  });

  const config = createDefaultWakeConfig(root);
  config.sources.github.policy.requiredLabels = ['wake:queue'];

  const tickRunner = createTickRunner({
    clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
    config,
    stateStore: store,
    workSource: {
      async pollEvents() {
        return [];
      },
    },
    runner: {
      async run(input) {
        runnerCallCount += 1;
        capturedAction = input.action;
        return {
          result: 'Renamed it and pushed.\nAWAITING_APPROVAL',
          model: 'test-model',
          cli: 'test-cli',
        };
      },
    },
    resourceIndex: createFakeResourceIndex(),
    workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
  });

  const result = await tickRunner.runTick();

  expect(result.status).toBe('processed');
  expect(runnerCallCount).toBe(1);
  expect(capturedAction).toBe('revise');

  const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 99 });
  expect(projection?.wake.stage).toBe('implement');
  expect(projection?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
});

it('stays idle when awaiting approval and the latest PR-sourced comment was already handled', async () => {
  const store = createStateStore({ wakeRoot: root });
  let runnerCallCount = 0;

  await store.writeIssueState({
    schemaVersion: 1,
    workItemKey: workId(98),
    issue: {
      repo: 'atolis-hq/wake',
      number: 98,
      title: 'Review Feedback Idle Test',
      body: 'Body',
      labels: ['wake:queue'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/98',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:05:00.000Z',
    },
    comments: [
      {
        id: 'pr-review-comment-402',
        body: 'Already addressed this.',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr:atolis-hq/wake#100',
      },
    ],
    latestComment: {
      id: 'pr-review-comment-402',
      body: 'Already addressed this.',
      author: { login: 'reviewer' },
      createdAt: '2026-07-05T12:05:00.000Z',
      updatedAt: '2026-07-05T12:05:00.000Z',
      isBotAuthored: false,
      resourceUri: 'github:pr:atolis-hq/wake#100',
    },
    wake: {
      stage: 'implement',
      stageHistory: [],
      recentEventIds: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {
      lastRunSentinel: 'AWAITING_APPROVAL',
      pendingApprovalAction: 'implement',
      lastHandledCommentId: 'pr-review-comment-402',
    },
    correlatedResources: [],
  });

  const config = createDefaultWakeConfig(root);
  config.sources.github.policy.requiredLabels = ['wake:queue'];

  const tickRunner = createTickRunner({
    clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
    config,
    stateStore: store,
    workSource: {
      async pollEvents() {
        return [];
      },
    },
    runner: {
      async run() {
        runnerCallCount += 1;
        return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
      },
    },
    resourceIndex: createFakeResourceIndex(),
    workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
  });

  const result = await tickRunner.runTick();

  expect(result.status).toBe('idle');
  expect(runnerCallCount).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/tick-runner.test.ts -t "revise action"`
Expected: FAIL on the first new test — `capturedAction` will be `undefined` (result is `idle`, runner never called), because `policy.resolvePendingReviewFeedback` doesn't exist yet on the wired-through object / the dispatch block doesn't call it.

(Note: if Task 1 hasn't landed yet in this branch, this fails with a TypeError instead — either way it fails, which is what this step checks for.)

- [ ] **Step 3: Wire the review-feedback branch into `shouldMarkPending`**

In `src/core/tick-runner.ts`, find `shouldMarkPending` (search for `function shouldMarkPending`). Replace:

```ts
if (isAwaitingApproval(projection)) {
  return policy.resolveApprovalTransition(projection) !== null;
}
```

with:

```ts
if (isAwaitingApproval(projection)) {
  return (
    policy.resolveApprovalTransition(projection) !== null ||
    policy.resolvePendingReviewFeedback(projection) !== null
  );
}
```

- [ ] **Step 4: Wire the review-feedback branch into the run-dispatch block**

In the same file, find the run-claiming block (search for `if (isAwaitingApproval(candidate)) {`). Replace this entire block:

```ts
        if (isAwaitingApproval(candidate)) {
          const approvalResolution = policy.resolveApprovalTransition(candidate);
          if (approvalResolution === null) {
            return { status: 'idle' as const };
          }

          if (approvalResolution.approved) {
            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            const nextStage = lifecycle.nextStageFromSentinel(candidate.wake.stage, 'DONE', workflow);
            if (nextStage === null) {
              return { status: 'idle' as const };
            }

            const approvalCompletedEvent = createEventEnvelope({
              eventId: `${approvalId}-completed`,
              workItemKey: candidate.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: 'wake.run.completed',
              sourceRefs: {
                repo: candidate.issue.repo,
                issueNumber: candidate.issue.number,
                runId: approvalId,
              },
              occurredAt: approvedAt,
              ingestedAt: approvedAt,
              trigger: 'immediate',
              payload: {
                action: approvalResolution.pendingAction,
                sentinel: 'DONE',
                nextStage,
                runId: approvalId,
                reason: 'human:approved',
                handledCommentId: latestHumanCommentId(candidate),
              },
            });
            await deps.stateStore.appendEventEnvelope(approvalCompletedEvent);
            await projectionUpdater.rebuildFromEvents([approvalCompletedEvent]);

            await deliverOutboundEvent(
              createLabelsEvent({
                projection: candidate,
                runId: approvalId,
                statusLabel: statusLabelForStage(nextStage),
                stageLabel: stageLabelForStage(nextStage),
                occurredAt: approvedAt,
              }),
            );

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage,
            };
          }

          action = approvalResolution.pendingAction;
          const workflowAction = chooseWorkflowAction(candidate, workflow);
          claimedStage = workflowAction?.stage ?? candidate.wake.stage;
          workspaceMode = workflowAction?.workspace ?? 'none';
        } else {
```

with:

```ts
        if (isAwaitingApproval(candidate)) {
          const approvalResolution = policy.resolveApprovalTransition(candidate);

          if (approvalResolution === null) {
            const reviewAction = policy.resolvePendingReviewFeedback(candidate);
            if (reviewAction === null) {
              return { status: 'idle' as const };
            }

            action = reviewAction;
            const workflowAction = chooseWorkflowAction(candidate, workflow);
            claimedStage = workflowAction?.stage ?? candidate.wake.stage;
            workspaceMode = workflowAction?.workspace ?? 'none';
          } else if (approvalResolution.approved) {
            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            const nextStage = lifecycle.nextStageFromSentinel(candidate.wake.stage, 'DONE', workflow);
            if (nextStage === null) {
              return { status: 'idle' as const };
            }

            const approvalCompletedEvent = createEventEnvelope({
              eventId: `${approvalId}-completed`,
              workItemKey: candidate.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: 'wake.run.completed',
              sourceRefs: {
                repo: candidate.issue.repo,
                issueNumber: candidate.issue.number,
                runId: approvalId,
              },
              occurredAt: approvedAt,
              ingestedAt: approvedAt,
              trigger: 'immediate',
              payload: {
                action: approvalResolution.pendingAction,
                sentinel: 'DONE',
                nextStage,
                runId: approvalId,
                reason: 'human:approved',
                handledCommentId: latestHumanCommentId(candidate),
              },
            });
            await deps.stateStore.appendEventEnvelope(approvalCompletedEvent);
            await projectionUpdater.rebuildFromEvents([approvalCompletedEvent]);

            await deliverOutboundEvent(
              createLabelsEvent({
                projection: candidate,
                runId: approvalId,
                statusLabel: statusLabelForStage(nextStage),
                stageLabel: stageLabelForStage(nextStage),
                occurredAt: approvedAt,
              }),
            );

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage,
            };
          } else {
            action = approvalResolution.pendingAction;
            const workflowAction = chooseWorkflowAction(candidate, workflow);
            claimedStage = workflowAction?.stage ?? candidate.wake.stage;
            workspaceMode = workflowAction?.workspace ?? 'none';
          }
        } else {
```

(The `} else {` at the very end of both blocks is the same line — it's the start of the pre-existing non-awaiting-approval branch, included here only so the replacement anchors unambiguously. Do not duplicate it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/core/tick-runner.test.ts`
Expected: PASS — the full file, including the 2 new tests and all pre-existing awaiting-approval tests (`/approved`, `/changes`, `/question`, conversation-idle, updatedAt-false-positive).

- [ ] **Step 6: Commit**

```bash
git add src/core/tick-runner.ts test/core/tick-runner.test.ts
git commit -m "tick-runner: dispatch the revise action for PR-sourced review feedback"
```

---

### Task 3: Surface the review comment's raw id so the agent can reply to other threads

**Files:**

- Modify: `src/adapters/runner/stage-prompt.ts`
- Test: `test/adapters/claude-runner.test.ts`

**Interfaces:**

- Consumes: `CommentSnapshot` (local type alias for `IssueStateRecord['comments'][number]`), specifically `comment.id` and `comment.reviewThread`.
- Produces: `formatComment` now emits a `Review-comment-id: <raw-id>` line for any comment with `reviewThread` set, giving the `revise` prompt (Task 4) the id it needs for `gh api .../replies` calls to threads other than the one Wake auto-replies to.

**Context:** `github-pull-request-activity-source.ts` composites review-comment ids as `` `pr-review-comment-${comment.id}` `` (see its `pr.review-comment.created` handler). This step strips that known prefix back off.

- [ ] **Step 1: Write the failing test**

In `test/adapters/claude-runner.test.ts`, add this test right after the existing test `'assembles a stage prompt from a projection summary and its comments'` (after its closing `});`):

```ts
it('surfaces the review-comment id for review-thread comments so the agent can reply to other threads', async () => {
  const result = await buildStagePrompt({
    action: 'implement',
    mode: 'resume',
    projection: {
      ...baseProjection,
      wake: { ...baseProjection.wake, stage: 'implement' as const },
      context: { lastHandledCommentId: 'c-0' },
      comments: [
        {
          id: 'c-0',
          body: 'Original comment.',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
          isBotAuthored: false,
        },
        {
          id: 'pr-review-comment-3609425102',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#254/rt_3609425102',
          reviewThread: { path: 'docs/workflows.md', line: 3 },
        },
      ],
      latestComment: {
        id: 'pr-review-comment-3609425102',
        body: 'Rename "item" to "work item"',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#254/rt_3609425102',
        reviewThread: { path: 'docs/workflows.md', line: 3 },
      },
    },
  });

  expect(result.prompt).toContain('Surface: review comment on docs/workflows.md:3');
  expect(result.prompt).toContain('Review-comment-id: 3609425102');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adapters/claude-runner.test.ts -t "surfaces the review-comment id"`
Expected: FAIL — `expect(result.prompt).toContain('Review-comment-id: 3609425102')` fails, the line doesn't exist yet.

- [ ] **Step 3: Implement the formatting change**

In `src/adapters/runner/stage-prompt.ts`, find `function formatComment` and replace it entirely:

```ts
function reviewCommentApiId(comment: CommentSnapshot): string | undefined {
  // github-pull-request-activity-source.ts composites review-comment ids as
  // `pr-review-comment-<id>`; strip that prefix back off to recover the raw
  // id `gh api .../pulls/comments/<id>/replies` needs.
  if (comment.reviewThread === undefined) {
    return undefined;
  }

  const match = /^pr-review-comment-(.+)$/.exec(comment.id);
  return match?.[1];
}

function formatComment(comment: CommentSnapshot): string {
  const surfaceLine =
    comment.reviewThread !== undefined
      ? `Surface: review comment on ${comment.reviewThread.path}${comment.reviewThread.line === undefined ? '' : `:${comment.reviewThread.line}`}`
      : comment.resourceUri !== undefined
        ? `Surface: ${comment.resourceUri}`
        : 'Surface: issue thread';
  const reviewCommentId = reviewCommentApiId(comment);

  return [
    '<wake-comment>',
    `Author: ${comment.author.login}`,
    `Created: ${comment.createdAt}`,
    `Bot-authored: ${comment.isBotAuthored ? 'yes' : 'no'}`,
    surfaceLine,
    ...(reviewCommentId === undefined ? [] : [`Review-comment-id: ${reviewCommentId}`]),
    'Body:',
    comment.body,
    '</wake-comment>',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/adapters/claude-runner.test.ts`
Expected: PASS — the full file, including the pre-existing prompt-assembly test (unaffected, since it has no `reviewThread` comments).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/runner/stage-prompt.ts test/adapters/claude-runner.test.ts
git commit -m "stage-prompt: surface the raw review-comment id for review-thread comments"
```

---

### Task 4: Add the `revise` prompt template

**Files:**

- Create: `prompts/revise.md`
- Test: `test/adapters/claude-runner.test.ts`

**Interfaces:**

- Consumes: the Handlebars context `buildStagePrompt` already builds (`workItemKey`, `repo`, `issueNumber`, `branch`, `isStart`/`isResume`, `allowedToolsList`, `toolCapabilityNote`, `feedbackCommandNote`) — same context every other prompt template gets, no changes needed to `stage-prompt.ts` for this task.
- Produces: `loadPromptTemplate('revise', mode, ...)` resolves to this file. No workflow/config wiring is needed for it to load — `buildStagePrompt`'s workspace-mode resolution comes from the _stage_ (`chooseAction(projection, workflow)`), not the action, and `claimedStage` stays `implement` when `revise` runs (Task 2), so this template automatically gets `workspaceMode: 'branch'` and the harness's `skipApproval:false` sentinel contract.

- [ ] **Step 1: Write the failing test**

In `test/adapters/claude-runner.test.ts`, add this test after the test added in Task 3:

```ts
it('renders the revise prompt with judgment instructions and reply-routing guidance', async () => {
  const result = await buildStagePrompt({
    action: 'revise',
    mode: 'resume',
    workspaceMode: 'branch',
    projection: {
      ...baseProjection,
      wake: { ...baseProjection.wake, stage: 'implement' as const },
      context: { lastHandledCommentId: 'c-0' },
      comments: [
        {
          id: 'pr-review-comment-3609425102',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#254/rt_3609425102',
          reviewThread: { path: 'docs/workflows.md', line: 3 },
        },
      ],
      latestComment: {
        id: 'pr-review-comment-3609425102',
        body: 'Rename "item" to "work item"',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#254/rt_3609425102',
        reviewThread: { path: 'docs/workflows.md', line: 3 },
      },
    },
  });

  expect(result.prompt).toContain('REVISE');
  expect(result.prompt).toContain('make it, commit, and push');
  expect(result.prompt).toContain('Do not change code solely because');
  expect(result.prompt).toContain('propose an alternative');
  expect(result.prompt).toContain('/replies');
  expect(result.prompt).toContain('Rename "item" to "work item"');
  expect(result.harnessPrompt).toContain('AWAITING_APPROVAL, BLOCKED, FAILED');
  expect(result.maxTurns).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adapters/claude-runner.test.ts -t "renders the revise prompt"`
Expected: FAIL — `loadPromptTemplate` throws `ENOENT` because `prompts/revise.md` doesn't exist.

- [ ] **Step 3: Create the prompt template**

Create `prompts/revise.md`:

```markdown
---
stage: implement
permissionMode: acceptEdits
allowedTools: Bash(git *), Bash(gh *), Bash(npm *), Bash(curl *), Bash(jq *), Edit, Write, Read, Glob, Grep, WebSearch, WebFetch
extraArgs:
maxTurns: 100
skipApproval: false
---

{{#if isStart}}
You are Wake, running the REVISE action for {{workItemKey}}, responding to
feedback on the pull request already open for this work item.

Your current working directory is a git checkout of {{repo}}, already on
branch {{branch}}, with an open pull request against main.

Wake will provide the comment(s) that triggered this run below in a
delimited untrusted data block. Each one is tagged with the surface it came
from — a specific file/line on the PR (a review comment) or the PR
conversation itself.
{{else}}
Resuming the REVISE action session for {{workItemKey}}.

Your current working directory is still the git checkout of {{repo}} on
branch {{branch}}. Continue from where you left off rather than starting
over, unless the new comments below change the approach.

New comments since your last turn (excludes Wake/bot comments) are provided
below in a delimited untrusted data block, tagged with the surface each one
came from.
{{/if}}

For each new comment, decide independently what it actually needs — do not
apply one blanket response to the whole batch:

- A concrete, reasonable change: make it, commit, and push to {{branch}}.
- A question, or something you'd want clarified before acting on it: answer
  it in your response. Do not change code solely because a question was
  asked.
- A request that seems mistaken, suboptimal, or in tension with the existing
  approach: don't implement it reflexively. Explain your reasoning, and
  either justify the current approach or propose an alternative. Reserve
  pushing back for requests you have a concrete, substantive reason to
  disagree with — when a reasonable person could go either way, prefer
  making the change over defending your original choice.

Reply routing: Wake automatically posts your prose response (this message,
not a git commit) as a reply to the surface of the single most recent
comment in this batch. If this batch includes review comments on more than
one thread, reply to every thread besides the most recent one yourself. Each
review comment below that needs a reply is tagged with its
`Review-comment-id`. Look up the PR number if you need it with `gh pr view
--json number -q .number`, then reply with:
`gh api repos/{{repo}}/pulls/<pr-number>/comments/<review-comment-id>/replies -f body="<reply>"`
Do not reply to the same comment more than once, and do not merge the pull
request yourself.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/adapters/claude-runner.test.ts`
Expected: PASS — the full file.

- [ ] **Step 5: Commit**

```bash
git add prompts/revise.md test/adapters/claude-runner.test.ts
git commit -m "prompts: add revise.md for PR review-feedback judgment"
```

---

### Task 5: Document the behavior and run full verification

**Files:**

- Modify: `docs/configuration.md`

- [ ] **Step 1: Add a doc note to the `pullRequests` config section**

In `docs/configuration.md`, find the `#### pullRequests` section's `**Important:**` paragraph (the one starting "A pull request opened by Wake's own agent as an artifact from an issue..."). Add this new paragraph immediately after it, before `## Loading and Merging`:

```markdown
**Reviewer feedback on Wake's own PRs:** while a work item is
`awaiting-approval`, a new comment on a correlated PR (a review, a
review-thread reply, or a plain PR comment) is treated as reviewer feedback
and automatically triggers Wake's `revise` action — unlike comments on the
originating issue, no `/approved`, `/changes`, or `/question` command is
required. The agent judges each comment independently: it may make the
change, answer a question, or push back with justification or an
alternative. The work item stays `awaiting-approval` afterward; only an
explicit `/approved` reply on the issue advances it to `done`.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm run verify`
Expected: build succeeds, all tests pass (including the new tests from Tasks 1-4).

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: document the revise action for PR review feedback"
```

## Self-Review Notes

- **Spec coverage:** "keep in mind someone may ask for a suboptimal change, the agent should decide whether to make the change, reply to a question, or push back justifying approach/proposing an alternative" → covered by `prompts/revise.md`'s three-way judgment instructions (Task 4). "Do we need a separate prompt file for PR comments?" → yes, `prompts/revise.md`, loaded via the existing `loadPromptTemplate(action, mode)` convention, no new plumbing (Task 4). "Change the mechanism specifically for PRs" → `resolvePendingReviewFeedback` (Task 1) only fires for comments carrying a `resourceUri` (PR/review-thread surface); issue-thread comments keep requiring `/approved`/`/changes`/`/question` (`resolveApprovalTransition`, unchanged).
- **Out of scope, by design:** the "auto-reply asking whether to action the comment" option from the earlier discussion — deliberately not implemented; discussed and rejected in favor of direct action.
- **No config/schema changes:** `revise` is a plain string `AgentAction`; routing (`resolveRunnerRouting`) keys off `claimedStage` (unchanged, stays `implement`), not `action`, and model selection (`resolveModel`) already falls back to `models.default` for action names with no explicit entry — verified against current source before writing this plan.

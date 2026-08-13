# GitHub Review Body Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every non-empty GitHub pull-request review body available as feedback while preserving approved and changes-requested signals.

**Architecture:** `githubReviewObservation` will return an array of drafts. A review body produces one feedback draft; `APPROVED` and `CHANGES_REQUESTED` additionally produce the existing command draft. The source already uses `flatMap`, so it will append each draft without another orchestration change.

**Tech Stack:** TypeScript, Vitest, GitHub REST payload adapters.

---

### Task 1: Specify review observation behavior

**Files:**
- Modify: `test/unit/integrations/github/source.test.ts`
- Modify: `test/e2e/scenarios/pr-trust.test.ts`

- [ ] **Step 1: Add a failing unit test for general review feedback**

```ts
it('emits a submitted COMMENTED review body as formal feedback', async () => {
  // Fake PR #6 with listReviews returning state COMMENTED and body 'general feedback'.
  // Assert one CommentObserved draft has body 'general feedback' and reviewKind 'formal'.
});
```

- [ ] **Step 2: Run the focused unit test and verify it fails**

Run: `npm test -- test/unit/integrations/github/source.test.ts`

Expected: the new assertion fails because `reviewCommand('COMMENTED')` returns `null` and produces no draft.

- [ ] **Step 3: Update existing direct observation callers for the array return**

```ts
const events = githubReviewObservation({ /* existing approved review */ });
const event = events.find((candidate) => candidate.payload.body === '/accepted');
if (event === undefined) throw new Error('Approved GitHub review was not translated');
```

### Task 2: Emit feedback and state drafts independently

**Files:**
- Modify: `src/integrations/github/infrastructure/review-source.ts:13-49`
- Modify: `src/integrations/github/infrastructure/source.ts:171-178`

- [ ] **Step 1: Return review drafts rather than a nullable single draft**

```ts
const body = input.review.body?.trim();
const feedback = body === undefined || body === '' ? [] : [feedbackDraft(input, body)];
const command = reviewCommand(input.review.state);
return command === null ? feedback : [...feedback, commandDraft(input, command)];
```

Use distinct stable IDs such as `github:review-feedback:<key>:<review-id>:<commit-id>` and retain the current `github:review:<key>:<review-id>:<state>:<commit-id>` command ID.

- [ ] **Step 2: Flatten review drafts at the source boundary**

```ts
return reviewEvents.flatMap((review) =>
  githubReviewObservation({ repository, pullRequest, review, authorizedReviewers: [] }),
);
```

- [ ] **Step 3: Run the focused unit test and verify it passes**

Run: `npm test -- test/unit/integrations/github/source.test.ts`

Expected: PASS; the general review body is emitted as a formal comment observation.

### Task 3: Verify approval compatibility and repository checks

**Files:**
- Modify: `test/unit/integrations/github/source.test.ts`

- [ ] **Step 1: Add an approved-review assertion**

```ts
// With state APPROVED and a non-empty body, assert the drafts contain both
// the body and '/accepted' exactly once.
```

- [ ] **Step 2: Run the focused test file and PR trust scenario**

Run: `npm test -- test/unit/integrations/github/source.test.ts test/e2e/scenarios/pr-trust.test.ts`

Expected: PASS; approved reviews still create `pr.review-accepted` through the command draft.

- [ ] **Step 3: Run static and formatting verification**

Run: `npm run lint && npm run format:check && npm run build`

Expected: all commands exit 0.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/integrations/github/infrastructure/review-source.ts src/integrations/github/infrastructure/source.ts test/unit/integrations/github/source.test.ts test/e2e/scenarios/pr-trust.test.ts docs/superpowers/plans/2026-08-13-github-review-body-intake.md
git commit -m "fix: retain GitHub review bodies"
```

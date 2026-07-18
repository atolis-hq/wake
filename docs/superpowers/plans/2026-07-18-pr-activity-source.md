# PR Activity Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let PR comments, reviews, and review-thread comments resume the correct work item's lifecycle and route replies back to the surface that triggered them, per [Issue #82](https://github.com/atolis-hq/wake/issues/82).

**Architecture:** A new `createGitHubPullRequestActivitySource` adapter (separate from the issues source) discovers qualifying standalone PRs and polls watchlisted, already-correlated PRs for activity. Unresolved events mint only if they pass a per-source qualification policy; PR/review comments fold into the existing `comments[]` array with surface tagging so the existing retry-trigger and prompt machinery pick them up unmodified. Replies route by the triggering event's `resourceUri`.

**Tech Stack:** TypeScript, zod, Octokit (`@octokit/rest`), vitest.

## Global Constraints

* Every runner invocation keeps `--max-turns` and a wall-clock timeout — untouched by this plan (no new runner invocations are added).
* `core/` never imports a concrete adapter; all new source/sink logic lives in `src/adapters/github/`.
* Every event append goes through `stateStore.appendEventEnvelope`, and every projection change goes through `projectionUpdater.rebuildFromEvents` — no direct `state/` writes.
* Fakes move symmetrically with real adapters in the same task, per repo convention — no task ships a real adapter change without its fake counterpart landing in the same commit.
* `rm -rf state/` + replay must still reproduce `state/` and the reverse index identically (CLAUDE.md invariant) — every new event type's fold must be replay-safe.
* Design doc: `docs/superpowers/specs/2026-07-18-pr-activity-source-design.md` — this plan implements it; deviations found during planning are called out per-task below with a **Design note**.

---

## File Structure

New files:
* `src/adapters/github/github-pull-request-activity-source.ts` — the new `WorkSource`/sink adapter.
* `src/adapters/fake/fake-github-pull-request-activity-source.ts` — its zero-token test fake.
* `test/adapters/github-pull-request-activity-source.test.ts`
* `test/adapters/artifact-verification.test.ts`
* `test/core/mint-qualification.test.ts`

Modified files (by task):
* `src/domain/schema.ts` — `parseRunnerArtifacts`, `commentSnapshotSchema` fields, `sources.github.pullRequests` config, `sourceRefs.resourceUri` kind helpers.
* `src/domain/types.ts` — new exported types.
* `src/domain/resource-uri.ts` — `pr-review-thread` kind helper (no schema change; kind is already opaque per the grammar).
* `src/core/contracts.ts` — `WorkSource.pollEvents({ watch })`.
* `src/core/tick-runner.ts` — artifact verification/registration, mint qualification gate, watchlist derivation.
* `src/core/policy-engine.ts` — `qualifiesForMint`.
* `src/core/sink-router.ts` — resourceUri-based sink targeting.
* `src/adapters/github/github-client.ts` — `getPullRequest`, `listPullRequests`, `listReviews`, `listReviewComments`, `replyToReviewComment`.
* `src/adapters/github/github-issues-work-source.ts` — filter out PR-shaped issues.
* `src/adapters/fake/fake-ticketing-system.ts` — `pollEvents({ watch })` signature (ignores it).
* `src/adapters/fake/fake-resource-index.ts` — no change needed (already generic).
* `src/adapters/runner/stage-prompt.ts` — surface/anchoring rendering in `formatComment`.
* `src/main.ts` — wire the new source/sink into `buildRuntime`.
* `README.md`, `docs/configuration.md`, `docs/architecture.md` — new config surface.

---

## Task 1: Runner artifact reporting — parse and verify

**Files:**
- Modify: `src/domain/schema.ts` (add near `parseRunnerResult`, after line 541)
- Modify: `src/domain/types.ts` (export new type)
- Test: `test/domain/schema.test.ts` (new describe block — check existing file first; create if absent at this path)

**Interfaces:**
- Produces: `parseRunnerArtifacts(result: string): { artifacts: Array<{ kind: 'pr'; url: string }> }` in `src/domain/schema.ts`, and `ReportedArtifact` type in `src/domain/types.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/domain/schema.test.ts
import { describe, expect, it } from 'vitest';
import { parseRunnerArtifacts } from '../../src/domain/schema.js';

describe('parseRunnerArtifacts', () => {
  it('parses a wake-artifacts fence', () => {
    const result = [
      'I opened a PR.',
      '',
      '```wake-artifacts',
      '{ "artifacts": [{ "kind": "pr", "url": "https://github.com/org/repo/pull/91" }] }',
      '```',
      '',
      '```wake-result',
      '{ "status": "AWAITING_APPROVAL" }',
      '```',
      'AWAITING_APPROVAL',
    ].join('\n');

    expect(parseRunnerArtifacts(result)).toEqual({
      artifacts: [{ kind: 'pr', url: 'https://github.com/org/repo/pull/91' }],
    });
  });

  it('returns no artifacts when the fence is absent', () => {
    expect(parseRunnerArtifacts('Nothing to report.\n\nDONE')).toEqual({ artifacts: [] });
  });

  it('returns no artifacts when the fence is malformed', () => {
    const result = ['```wake-artifacts', 'not json', '```', 'DONE'].join('\n');
    expect(parseRunnerArtifacts(result)).toEqual({ artifacts: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/domain/schema.test.ts -t "parseRunnerArtifacts"`
Expected: FAIL — `parseRunnerArtifacts is not a function` (if `test/domain/schema.test.ts` doesn't exist yet, create it with just this describe block and the import at the top).

- [ ] **Step 3: Add the schema and parser**

In `src/domain/schema.ts`, add after the `resourceUriSchema`/correlation imports (near line 13):

```typescript
const reportedArtifactSchema = z.object({
  kind: z.literal('pr'),
  url: z.string().url(),
});

export const wakeArtifactsEnvelopeSchema = z.object({
  artifacts: z.array(reportedArtifactSchema).default([]),
});
```

Add after `parseRunnerResult` (after line 541, before `parseRunnerResultSentinel`):

```typescript
export function parseRunnerArtifacts(result: string): z.infer<typeof wakeArtifactsEnvelopeSchema> {
  const fencePattern = /^```wake-artifacts[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(result)) !== null) {
    lastMatch = match;
  }

  if (lastMatch === null) {
    return { artifacts: [] };
  }

  try {
    const parsed = wakeArtifactsEnvelopeSchema.safeParse(JSON.parse(lastMatch[1] ?? '{}'));
    return parsed.success ? parsed.data : { artifacts: [] };
  } catch {
    return { artifacts: [] };
  }
}
```

In `src/domain/types.ts`, add near the other payload type exports (after `CorrelatedResource`, line 53):

```typescript
export type ReportedArtifact = z.infer<typeof reportedArtifactSchemaForType>;
```

This requires exporting the inner schema too — in `schema.ts`, rename the local `reportedArtifactSchema` usage: export it as `export const reportedArtifactSchema = ...` (drop the `const` privacy), then in `types.ts` import `reportedArtifactSchema` (not a renamed alias) and use:

```typescript
export type ReportedArtifact = z.infer<typeof reportedArtifactSchema>;
```

Add the import line in `types.ts` alongside the existing `schema.js` import block (line 3-17):

```typescript
  reportedArtifactSchema,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/domain/schema.test.ts -t "parseRunnerArtifacts"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/domain/schema.ts src/domain/types.ts test/domain/schema.test.ts
git commit -m "Add parseRunnerArtifacts for structured PR reporting"
```

---

## Task 2: Prompt instructs the agent to report artifacts

**Files:**
- Modify: `src/adapters/runner/stage-prompt.ts:143-191` (`buildHarnessPrompt`)
- Test: `test/adapters/prompt-templates.test.ts` (check existing content first; add a case)

**Interfaces:**
- Consumes: nothing new.
- Produces: harness prompt text containing `wake-artifacts` instructions, read by Task 3's verification step only implicitly (the agent's raw text output is parsed by `parseRunnerArtifacts`, not by anything in this task).

- [ ] **Step 1: Write the failing test**

Read `test/adapters/prompt-templates.test.ts` first to match its existing assertion style (it asserts on `buildStagePrompt(...).harnessPrompt` substrings per the file already read during planning). Add:

```typescript
it('instructs the agent to report PR artifacts', async () => {
  const result = await buildStagePrompt({
    action: 'implement',
    projection: /* reuse the existing fixture projection already built earlier in this file */,
  });

  expect(result.harnessPrompt).toContain('wake-artifacts');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/prompt-templates.test.ts -t "artifacts"`
Expected: FAIL — harness prompt does not contain `wake-artifacts`.

- [ ] **Step 3: Add the instruction**

In `src/adapters/runner/stage-prompt.ts`, modify `buildHarnessPrompt` (lines 143-191): insert a new block after the "Result envelope ABI" block (after line 187, before the final `return lines.join('\n')`):

```typescript
  lines.push(
    '',
    'Artifact reporting:',
    'If you created a pull request during this stage, report it before the result envelope by adding a fenced `wake-artifacts` JSON block:',
    '```wake-artifacts',
    '{ "artifacts": [{ "kind": "pr", "url": "<the PR URL>" }] }',
    '```',
    'Only report a PR you actually created in this run. Omit the block entirely if you created no PR.',
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/prompt-templates.test.ts -t "artifacts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/runner/stage-prompt.ts test/adapters/prompt-templates.test.ts
git commit -m "Instruct agents to report PR artifacts via wake-artifacts fence"
```

---

## Task 3: `getPullRequest` on the GitHub client + fake equivalent

**Files:**
- Modify: `src/adapters/github/github-client.ts:1-70`
- Test: `test/adapters/github-client.test.ts` (check for an existing file; if none exists, create one covering just this method with a mocked Octokit, matching whatever mocking pattern `test/adapters/github-issues-work-source.test.ts` already uses for `deps.client`)

**Interfaces:**
- Produces: `client.getPullRequest(owner: string, repo: string, pullNumber: number): Promise<{ number: number; html_url: string; head: { ref: string; sha: string }; user: { login: string } | null; state: string }>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/adapters/github-client.test.ts
import { describe, expect, it, vi } from 'vitest';

describe('createGitHubClient.getPullRequest', () => {
  it('fetches a single PR by number', async () => {
    const getPull = vi.fn().mockResolvedValue({
      data: {
        number: 91,
        html_url: 'https://github.com/org/repo/pull/91',
        head: { ref: 'wake/issue-82', sha: 'abc123' },
        user: { login: 'eddy-bot' },
        state: 'open',
      },
    });

    // Mirror however github-client.test.ts (or github-issues-work-source.test.ts)
    // already stubs Octokit's constructor/rest surface in this repo, wiring
    // octokit.rest.pulls.get = getPull, then:
    // const client = createGitHubClient('token');
    // const pr = await client.getPullRequest('org', 'repo', 91);
    // expect(getPull).toHaveBeenCalledWith({ owner: 'org', repo: 'repo', pull_number: 91 });
    // expect(pr.head.ref).toBe('wake/issue-82');
  });
});
```

(Replace the comment block above with real Octokit-stubbing code matching the existing test file's mocking convention — read `test/adapters/github-issues-work-source.test.ts`'s top-of-file mock setup before writing this, since `createGitHubClient` wraps `new Octokit(...)` directly and the existing tests already have a working stub for it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: FAIL — `client.getPullRequest is not a function`

- [ ] **Step 3: Implement**

In `src/adapters/github/github-client.ts`, add inside the returned object (after `setLabels`, before the closing `};` at line 69):

```typescript
    async getPullRequest(owner: string, repo: string, pullNumber: number) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return data;
    },
    async listPullRequests(owner: string, repo: string, maxResults: number) {
      const perPage = Math.min(maxResults, 100);
      const results: Awaited<ReturnType<typeof octokit.rest.pulls.list>>['data'] = [];

      for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: 'open',
        per_page: perPage,
      })) {
        results.push(...data);
        if (results.length >= maxResults) {
          break;
        }
      }

      return results.slice(0, maxResults);
    },
    async listReviews(owner: string, repo: string, pullNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
      });
    },
    async listReviewComments(owner: string, repo: string, pullNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
      });
    },
    async replyToReviewComment(
      owner: string,
      repo: string,
      pullNumber: number,
      commentId: number,
      body: string,
    ) {
      return octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: commentId,
        body,
      });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/github-client.ts test/adapters/github-client.test.ts
git commit -m "Add PR read/reply methods to the GitHub client"
```

---

## Task 4: Verify and register agent-reported PR artifacts

**Design note:** verification needs a GitHub client, but `tick-runner.ts` is provider-agnostic (`core/` never imports a concrete adapter). Verification is therefore injected as an optional dependency shaped like a small interface, wired to the real GitHub client only in `main.ts`, with a fake in tests — matching every other seam in this codebase.

**Files:**
- Modify: `src/core/contracts.ts` (new `ArtifactVerifier` interface)
- Modify: `src/core/tick-runner.ts` (call verification + registration after a successful run)
- Modify: `src/adapters/fake/fake-artifact-verifier.ts` (new file)
- Modify: `src/adapters/github/github-artifact-verifier.ts` (new file)
- Modify: `src/main.ts` (wire it into `buildRuntime` and `createTickRunner`)
- Test: `test/core/tick-runner.test.ts` (existing file — add a new describe block)

**Interfaces:**
- Consumes: `parseRunnerArtifacts` (Task 1), `CORRELATION_REGISTERED_EVENT` (existing).
- Produces: `ArtifactVerifier.verify(artifact: ReportedArtifact, context: { branch: string }): Promise<{ resourceUri: string } | null>` in `src/core/contracts.ts`. `createTickRunner` gains an optional `deps.artifactVerifier?: ArtifactVerifier`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/tick-runner.test.ts — new describe block, using this file's existing
// createFakeRunner/createFakeTicketingSystem/createFakeWorkspaceManager/createFakeResourceIndex
// harness setup (copy the existing "implement stage completes" setup as a base).
import { createFakeArtifactVerifier } from '../../src/adapters/fake/fake-artifact-verifier.js';

describe('artifact reporting', () => {
  it('registers a verified PR artifact reported by the agent', async () => {
    const artifactVerifier = createFakeArtifactVerifier({
      verifies: [{ url: 'https://example.test/org/repo/pull/91', resourceUri: 'github:pr:org/repo#91' }],
    });
    const runner = createFakeRunner({
      result: [
        'Opened the PR.',
        '',
        '```wake-artifacts',
        '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
        '```',
        '',
        '```wake-result',
        '{ "status": "AWAITING_APPROVAL" }',
        '```',
        'AWAITING_APPROVAL',
      ].join('\n'),
      model: 'fake',
      cli: 'Fake',
      session_id: 'fake-session-1',
    });

    // ... build tickRunner with this runner and artifactVerifier, seed one
    // ticket already in 'implement' stage (mirror an existing implement-stage
    // test in this file), run two ticks (claim + complete), then:

    const projection = await stateStore.readIssueState(workItemKey);
    expect(projection?.correlatedResources).toContainEqual(
      expect.objectContaining({
        resourceUri: 'github:pr:org/repo#91',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
      }),
    );
  });

  it('does not register an artifact that fails verification', async () => {
    const artifactVerifier = createFakeArtifactVerifier({ verifies: [] }); // verify() always returns null
    // ... same runner reporting the same artifact, same setup ...
    const projection = await stateStore.readIssueState(workItemKey);
    expect(projection?.correlatedResources.some((r) => r.resourceUri === 'github:pr:org/repo#91')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tick-runner.test.ts -t "artifact reporting"`
Expected: FAIL — `createFakeArtifactVerifier` does not exist.

- [ ] **Step 3: Add the contract**

In `src/core/contracts.ts`, add after the `WorkspaceManager` interface (end of file):

```typescript
export interface ArtifactVerifier {
  verify(
    artifact: import('../domain/types.js').ReportedArtifact,
    context: { branch: string },
  ): Promise<{ resourceUri: string } | null>;
}
```

- [ ] **Step 4: Add the fake**

```typescript
// src/adapters/fake/fake-artifact-verifier.ts
import type { ArtifactVerifier } from '../../core/contracts.js';

/**
 * Permanent test harness. `verifies` is the allowlist of URLs this fake
 * treats as legitimate, mapped to the resourceUri they resolve to — anything
 * not listed fails verification, exercising the "malformed claim" path.
 */
export function createFakeArtifactVerifier(options: {
  verifies: Array<{ url: string; resourceUri: string }>;
}): ArtifactVerifier {
  const byUrl = new Map(options.verifies.map((entry) => [entry.url, entry.resourceUri]));

  return {
    async verify(artifact) {
      const resourceUri = byUrl.get(artifact.url);
      return resourceUri === undefined ? null : { resourceUri };
    },
  };
}
```

- [ ] **Step 5: Add the real GitHub verifier**

```typescript
// src/adapters/github/github-artifact-verifier.ts
import type { ArtifactVerifier } from '../../core/contracts.js';
import { buildResourceUri } from '../../domain/resource-uri.js';

const githubPrUrlPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function createGitHubArtifactVerifier(deps: {
  client: { getPullRequest: (owner: string, repo: string, pullNumber: number) => Promise<{ head: { ref: string } }> };
}): ArtifactVerifier {
  return {
    async verify(artifact, context) {
      if (artifact.kind !== 'pr') {
        return null;
      }

      const match = githubPrUrlPattern.exec(artifact.url);
      if (match === null) {
        return null;
      }
      const [, owner, repo, numberStr] = match;
      if (owner === undefined || repo === undefined || numberStr === undefined) {
        return null;
      }

      try {
        const pr = await deps.client.getPullRequest(owner, repo, Number(numberStr));
        if (pr.head.ref !== context.branch) {
          return null;
        }
        return { resourceUri: buildResourceUri('github', 'pr', `${owner}/${repo}#${numberStr}`) };
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 6: Wire verification + registration into `createTickRunner`**

In `src/core/tick-runner.ts`, add `artifactVerifier?: import('./contracts.js').ArtifactVerifier;` to the `deps` parameter of `createTickRunner` (in the type object starting line 44, add after `resourceIndex: ResourceIndex;`).

Add the import at the top (near line 24):

```typescript
import { parseRunnerArtifacts } from '../domain/schema.js';
```

Add a helper function above `runTick` (near `createLabelsEvent`, e.g. after line 255):

```typescript
  async function registerReportedArtifacts(input: {
    projection: IssueStateRecord;
    runId: string;
    runnerResult: AgentRunResult;
    branch: string;
    occurredAt: string;
  }): Promise<void> {
    if (deps.artifactVerifier === undefined) {
      return;
    }

    const { artifacts } = parseRunnerArtifacts(input.runnerResult.result);
    for (const artifact of artifacts) {
      const verified = await deps.artifactVerifier.verify(artifact, { branch: input.branch });
      if (verified === null) {
        continue;
      }

      await deliverOutboundEvent(
        createEventEnvelope({
          eventId: `${input.runId}-artifact-${artifact.kind}-${verified.resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
          workItemKey: input.projection.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: CORRELATION_REGISTERED_EVENT,
          sourceRefs: { runId: input.runId },
          occurredAt: input.occurredAt,
          ingestedAt: input.occurredAt,
          trigger: 'context-only',
          payload: {
            resourceUri: verified.resourceUri,
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredBy: input.runId,
          },
        }),
      );
    }
  }
```

Note `deliverOutboundEvent` also attempts sink delivery for this event — `wake.correlation.registered` is not a publish-intent type, so `attemptDelivery`'s outbound sink call is harmless (no sink subscribes to it) but does append it via `stateStore.appendEventEnvelope` + fold, which is what's needed. If this proves noisy in practice, switch to the plain `appendEventEnvelope` + `rebuildFromEvents` pair used elsewhere for internal-only events (see `buildOriginCorrelationEvents`' callers) instead of `deliverOutboundEvent` — do this now rather than deferring, since it's a one-line difference: replace the `deliverOutboundEvent(...)` call above with:

```typescript
      const event = createEventEnvelope({ /* same fields as above */ });
      const appended = await deps.stateStore.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([appended]);
```

Call `registerReportedArtifacts` in the success path of `runTick`, right after `parsedRunnerResult` is computed and before `nextStage` is used for the run record (after line 1021, `const rawSentinel = parsedRunnerResult.status;`), only for the `implement` action (only implement has a workspace/branch):

```typescript
          if (action === 'implement') {
            await registerReportedArtifacts({
              projection: candidate,
              runId,
              runnerResult,
              branch: (await import('../adapters/git/git-workspace-manager.js')).branchNameForIssue(candidate.issue.number),
              occurredAt: finishedAt,
            });
          }
```

(`finishedAt` is defined two lines below at line 1032 in the current file — move this call to just after `const finishedAt = deps.clock.now().toISOString();` instead, so `finishedAt` is in scope. Use a static top-of-file import for `branchNameForIssue` instead of a dynamic import — add `import { branchNameForIssue } from '../adapters/git/git-workspace-manager.js';` near the other top-of-file imports.)

- [ ] **Step 7: Wire into `main.ts`**

In `src/main.ts`, inside `buildRuntime` (after `const resourceIndex = ...` at line 216), add:

```typescript
  const artifactVerifier = config.sources.github.enabled
    ? createGitHubArtifactVerifier({ client: createGitHubClient(await resolveGitHubToken()) })
    : undefined;
```

Add the import near the other adapter imports (after the `createGitHubIssuesWorkSource` import, line 22):

```typescript
import { createGitHubArtifactVerifier } from './adapters/github/github-artifact-verifier.js';
```

Pass it to `createTickRunner` (in the call around line 269-278):

```typescript
  const tickRunner = createTickRunner({
    clock: systemClock,
    config,
    stateStore,
    workSource,
    outboundSink,
    runner,
    workspaceManager,
    resourceIndex,
    artifactVerifier,
  });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/core/tick-runner.test.ts -t "artifact reporting"`
Expected: PASS (2 tests)

Run: `npm run build` (confirm no type errors from the new optional dep and the new import in tick-runner.ts)
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/contracts.ts src/core/tick-runner.ts src/adapters/fake/fake-artifact-verifier.ts src/adapters/github/github-artifact-verifier.ts src/main.ts test/core/tick-runner.test.ts
git commit -m "Verify and register agent-reported PR artifacts"
```

---

## Task 5: Mint qualification config + `qualifiesForMint`

**Files:**
- Modify: `src/domain/schema.ts:371-390` (`sources.github` schema — add `pullRequests`)
- Modify: `src/core/policy-engine.ts` (extract shared label/assignee check, add `qualifiesForMint`)
- Test: `test/core/mint-qualification.test.ts` (new)

**Interfaces:**
- Consumes: `UnkeyedEventEnvelope` shape (existing), `WakeConfig` (existing).
- Produces: `policy.qualifiesForMint(unresolved: UnkeyedEventEnvelope, config: WakeConfig): boolean`, used by Task 6.

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/mint-qualification.test.ts
import { describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../src/core/policy-engine.js';
import { parseWakeConfig } from '../../src/domain/schema.js';
import { createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return parseWakeConfig({
    paths: { wakeRoot: '/tmp/wake' },
    sources: {
      github: {
        enabled: true,
        repos: ['org/repo'],
        policy: { requiredLabels: ['wake:assign'], requiredAssignees: [] },
        pullRequests: { enabled: true, policy: { requiredAuthors: ['trusted-human'] } },
        ...overrides,
      },
    },
  });
}

describe('qualifiesForMint', () => {
  const policy = createPolicyEngine();

  it('qualifies a github:issue event carrying a matching label', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e1',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#1' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { labels: ['wake:assign'], assignees: [] } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(true);
  });

  it('does not qualify a github:issue event missing the required label', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e2',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { resourceUri: 'github:issue:org/repo#2' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: { ticket: { labels: [], assignees: [] } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });

  it('qualifies a github:pr event authored by a required author', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e3',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 91, author: 'trusted-human', headRef: 'feature-x' } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(true);
  });

  it('does not qualify a github:pr event authored by an unlisted author', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e4',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github-pr',
      sourceEventType: 'pr.seen',
      sourceRefs: { resourceUri: 'github:pr:org/repo#92' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { pr: { number: 92, author: 'random-person', headRef: 'feature-y' } },
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });

  it('does not qualify an event with no resourceUri', () => {
    const event = createUnkeyedEventEnvelope({
      eventId: 'e5',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {},
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'immediate',
      payload: {},
    });
    expect(policy.qualifiesForMint(event, baseConfig())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/mint-qualification.test.ts`
Expected: FAIL — `sources.github.pullRequests` schema key doesn't exist yet / `qualifiesForMint` doesn't exist.

- [ ] **Step 3: Extend the config schema**

In `src/domain/schema.ts`, modify the `sources` object (lines 371-390). Replace the `github: z.object({...}).default({...})` block with (adding `pullRequests` alongside the existing `policy`/`publication` keys):

```typescript
  sources: z.object({
    github: z.object({
      enabled: z.boolean().default(false),
      repos: z.array(z.string().min(1)).default([]),
      polling: z.object({
        maxIssuesPerRepo: z.number().int().positive().default(25),
        commentPageSize: z.number().int().positive().default(25),
        lookbackMs: z.number().int().nonnegative().default(60_000),
      }).default({ maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }),
      policy: z.object({
        requiredLabels: z.array(z.string()).default([]),
        ignoredLabels: z.array(z.string()).default([]),
        requiredAssignees: z.array(z.string()).default([]),
      }).default({ requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }),
      publication: z.object({
        postStatusComments: z.boolean().default(true),
        activeLabel: z.string().optional(),
      }).default({ postStatusComments: true }),
      pullRequests: z.object({
        enabled: z.boolean().default(false),
        maxPullRequestsPerRepo: z.number().int().positive().default(25),
        commentPageSize: z.number().int().positive().default(25),
        policy: z.object({
          requiredAuthors: z.array(z.string()).default([]),
        }).default({ requiredAuthors: [] }),
      }).default({ enabled: false, maxPullRequestsPerRepo: 25, commentPageSize: 25, policy: { requiredAuthors: [] } }),
    }).default({ enabled: false, repos: [], polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }, policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }, publication: { postStatusComments: true }, pullRequests: { enabled: false, maxPullRequestsPerRepo: 25, commentPageSize: 25, policy: { requiredAuthors: [] } } }),
  }).default({ github: { enabled: false, repos: [], polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }, policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] }, publication: { postStatusComments: true }, pullRequests: { enabled: false, maxPullRequestsPerRepo: 25, commentPageSize: 25, policy: { requiredAuthors: [] } } } }),
```

- [ ] **Step 4: Add `qualifiesForMint` to policy-engine.ts**

In `src/core/policy-engine.ts`, extract the shared label/assignee logic from `isEligible` into a helper, then add `qualifiesForMint`. Add near the top of the file (after the existing `matchesCommand` function, before `latestUnhandledHumanComment`):

```typescript
function labelsAndAssigneesQualify(input: {
  labels: string[];
  assignees: string[];
  requiredLabels: string[];
  ignoredLabels: string[];
  requiredAssignees: string[];
}): boolean {
  if (input.requiredLabels.length === 0 && input.requiredAssignees.length === 0) {
    return false;
  }

  const labels = new Set(input.labels);
  const assignees = new Set(input.assignees);

  if (input.requiredLabels.some((label) => !labels.has(label))) {
    return false;
  }

  if (input.ignoredLabels.some((label) => labels.has(label))) {
    return false;
  }

  if (input.requiredAssignees.length > 0 && !input.requiredAssignees.some((login) => assignees.has(login))) {
    return false;
  }

  return true;
}
```

Update `isEligible` (lines 60-97) to use it — replace the body from `const labels = new Set(...)` (line 68) through the `return true;` label/assignee checks (lines 79-96) with:

```typescript
      return labelsAndAssigneesQualify({
        labels: issue.issue.labels,
        assignees: issue.issue.assignees,
        requiredLabels,
        ignoredLabels: config.sources.github.policy.ignoredLabels,
        requiredAssignees,
      });
```

(Keep the `state !== 'open'` and `isPullRequest` early returns above it as-is for now — `isPullRequest` removal is Task 7.)

Add `qualifiesForMint` as a new method on the object returned by `createPolicyEngine` (add it after `resolveApprovalTransition`, before the closing `};` at line 218). It needs the `UnkeyedEventEnvelope` type — add the import at the top of the file:

```typescript
import type { UnkeyedEventEnvelope } from './contracts.js';
```

```typescript
    qualifiesForMint(unresolved: UnkeyedEventEnvelope, config: WakeConfig): boolean {
      const resourceUri = unresolved.sourceRefs.resourceUri;
      if (resourceUri === undefined) {
        return false;
      }

      const kind = resourceUri.split(':')[1];

      if (kind === 'issue') {
        const ticket = unresolved.payload.ticket as
          | { labels?: unknown; assignees?: unknown }
          | undefined;
        if (ticket === undefined) {
          return false;
        }
        return labelsAndAssigneesQualify({
          labels: Array.isArray(ticket.labels) ? ticket.labels : [],
          assignees: Array.isArray(ticket.assignees) ? ticket.assignees : [],
          requiredLabels: config.sources.github.policy.requiredLabels,
          ignoredLabels: config.sources.github.policy.ignoredLabels,
          requiredAssignees: config.sources.github.policy.requiredAssignees,
        });
      }

      if (kind === 'pr') {
        const pr = unresolved.payload.pr as { author?: unknown } | undefined;
        const requiredAuthors = config.sources.github.pullRequests.policy.requiredAuthors;
        if (requiredAuthors.length === 0 || typeof pr?.author !== 'string') {
          return false;
        }
        return requiredAuthors.includes(pr.author);
      }

      return false;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/mint-qualification.test.ts`
Expected: PASS (5 tests)

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: PASS (no regressions — `isEligible` behavior is unchanged, only refactored)

- [ ] **Step 6: Commit**

```bash
git add src/domain/schema.ts src/core/policy-engine.ts test/core/mint-qualification.test.ts
git commit -m "Add per-source mint qualification policy"
```

---

## Task 6: Resolver gates minting on qualification; unresolved events park in global-intake

**Design note:** introduces a shared sentinel `UNRESOLVED_WORK_ITEM_KEY = 'unresolved'` for events that fail qualification. `rebuildFromEvents` looks up `readIssueState('unresolved')`, which is always `null` (no such file is ever written), and `applyEvent` returns `null` for any non-upsert event type when `current === null` — so these events are durable and queryable via the event log, but never materialize a projection file. The persisted-event healing branch (lines 419-446 of the current `tick-runner.ts`) must skip this sentinel key entirely, or it will spuriously attempt to re-mint on every tick.

**Files:**
- Modify: `src/core/tick-runner.ts:382-469` (`resolveInboundEvent`)
- Test: `test/core/tick-runner.test.ts` (new describe block)

**Interfaces:**
- Consumes: `policy.qualifiesForMint` (Task 5).
- Produces: events with `workItemKey === 'unresolved'` and `streamScope: 'global-intake'` for unqualified misses — consumed by nothing yet in this plan (recovery via `wake correlate` is manual, per the design's deferred scope).

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/tick-runner.test.ts — new describe block, reusing this file's
// existing tickRunner-building helpers.
describe('mint qualification gate', () => {
  it('parks an unqualified unresolved event in global-intake instead of minting', async () => {
    // Seed a fake ticketing system whose one ticket carries no labels, and a
    // config with sources.github.policy.requiredLabels: ['wake:assign'] (so
    // isEligible/qualifiesForMint both reject it) — mirror this file's existing
    // "issue that does not qualify" fixture if one exists, otherwise build a
    // FakeTicketSeed with labels: [].
    const outcome = await tickRunner.runTick();
    expect(outcome.status).toBe('idle');

    const projections = await stateStore.listIssueStates();
    expect(projections).toHaveLength(0);

    const events = await stateStore.listEventEnvelopesForWorkItem('unresolved', 10);
    // listEventEnvelopesForWorkItem reads recentEventIds off a projection,
    // which 'unresolved' never has — so assert via the raw event log instead:
    // list events for the date partition covering "now" and filter
    // workItemKey === 'unresolved'. If no existing helper does this, read
    // stateStore.paths.eventFile(dateString) directly with readJsonLines
    // (check src/lib for an existing JSONL reader used by other tests).
  });

  it('still mints a work item for a qualifying unresolved event', async () => {
    // Existing-style fixture: labels include the required label.
    const outcome = await tickRunner.runTick();
    expect(outcome.status).not.toBe('idle');
    const projections = await stateStore.listIssueStates();
    expect(projections).toHaveLength(1);
  });
});
```

(Before finalizing this test, check `src/lib/` for an existing JSONL event-file reader other tests already use to assert on raw appended events — `state-store.test.ts` almost certainly has one; reuse that helper rather than inventing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tick-runner.test.ts -t "mint qualification gate"`
Expected: FAIL — every unresolved event currently mints regardless of qualification.

- [ ] **Step 3: Implement the gate**

In `src/core/tick-runner.ts`, add the sentinel constant near the top (after the `type ResolvedInboundEvent = ...` line, ~line 37):

```typescript
// Shared key for events whose resource failed mint qualification (spec D1').
// Never a real work item: readIssueState('unresolved') always returns null,
// so these events are durable and inspectable via the event log but never
// materialize a projection or an entry in the resource index.
const UNRESOLVED_WORK_ITEM_KEY = 'unresolved';
```

Modify `resolveInboundEvent` (lines 395-469). The healing branch's guard (line 432-433) must first exclude the sentinel — change:

```typescript
      const owner = await deps.resourceIndex.resolve(resourceUri);
      if (
        owner === undefined &&
        (await deps.stateStore.readEventEnvelope(
          `${persisted.workItemKey}-origin-correlation`,
        )) === null
      ) {
```

to:

```typescript
      const owner = await deps.resourceIndex.resolve(resourceUri);
      if (
        persisted.workItemKey !== UNRESOLVED_WORK_ITEM_KEY &&
        owner === undefined &&
        (await deps.stateStore.readEventEnvelope(
          `${persisted.workItemKey}-origin-correlation`,
        )) === null
      ) {
```

Then, in the miss branch (lines 449-468), gate minting on qualification — replace:

```typescript
    const existingWorkItemKey = await deps.resourceIndex.resolve(resourceUri);
    if (existingWorkItemKey !== undefined) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: existingWorkItemKey }),
          persisted: false,
        },
      ];
    }

    const workItemKey = createWorkId();
    const keyed = createEventEnvelope({ ...unkeyed, workItemKey });

    return [
      { envelope: keyed, persisted: false },
      ...buildOriginCorrelationEvents(workItemKey, unkeyed, resourceUri).map((envelope) => ({
        envelope,
        persisted: false,
      })),
    ];
```

with:

```typescript
    const existingWorkItemKey = await deps.resourceIndex.resolve(resourceUri);
    if (existingWorkItemKey !== undefined) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: existingWorkItemKey }),
          persisted: false,
        },
      ];
    }

    if (!policy.qualifiesForMint(unkeyed, deps.config)) {
      return [
        {
          envelope: createEventEnvelope({ ...unkeyed, workItemKey: UNRESOLVED_WORK_ITEM_KEY }),
          persisted: false,
        },
      ];
    }

    const workItemKey = createWorkId();
    const keyed = createEventEnvelope({ ...unkeyed, workItemKey });

    return [
      { envelope: keyed, persisted: false },
      ...buildOriginCorrelationEvents(workItemKey, unkeyed, resourceUri).map((envelope) => ({
        envelope,
        persisted: false,
      })),
    ];
```

`policy` is already in scope inside `createTickRunner` (defined at the top via `createPolicyEngine()`, line 57) — no new wiring needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/tick-runner.test.ts`
Expected: PASS, including the new describe block and no regressions in existing tick-runner tests (existing issues source tests all supply `requiredLabels`/`requiredAssignees` fixtures that already qualify, per the unchanged `isEligible` logic Task 5 preserved).

- [ ] **Step 5: Commit**

```bash
git add src/core/tick-runner.ts test/core/tick-runner.test.ts
git commit -m "Gate work-item minting on per-source qualification"
```

---

## Task 7: Issues source stops emitting PR-shaped items

**Files:**
- Modify: `src/adapters/github/github-issues-work-source.ts:390-436` (the polling loop)
- Modify: `src/core/policy-engine.ts:71-77` (remove now-dead `isPullRequest` check — optional cleanup, do it since the design calls it out explicitly)
- Test: `test/adapters/github-issues-work-source.test.ts` (new case)

**Interfaces:**
- No signature changes — behavior only.

- [ ] **Step 1: Write the failing test**

```typescript
// test/adapters/github-issues-work-source.test.ts — add near other pollEvents tests
it('never emits PR-shaped issues', async () => {
  // Reuse this file's existing client-stubbing pattern; make listIssues return
  // one plain issue and one item with pull_request: {} set.
  const events = await source.pollEvents();
  const upsertEvents = events.filter((e) => e.sourceEventType === 'ticket.upsert');
  expect(upsertEvents).toHaveLength(1);
  expect((upsertEvents[0]?.payload.ticket as { number: number }).number).not.toBe(
    /* the PR's number */ 999,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/github-issues-work-source.test.ts -t "never emits"`
Expected: FAIL — both items currently emitted.

- [ ] **Step 3: Filter at poll time**

In `src/adapters/github/github-issues-work-source.ts`, in the `pollEvents` loop (starts line 357), immediately after `for (const issue of issues) {` (line 390), add:

```typescript
          for (const issue of issues) {
            if (issue.pull_request !== undefined) {
              continue;
            }

```

(This is a one-line-plus-guard insertion right after the existing `for (const issue of issues) {` at line 390 — do not remove the line, just add the guard as its new first statement.)

- [ ] **Step 4: Remove the now-dead policy check**

In `src/core/policy-engine.ts`, `isEligible` (around line 71-77 as originally read, now shifted slightly by Task 5's refactor — locate by content, not line number): remove the block

```typescript
      if (issue.issue.isPullRequest) {
        return false;
      }
```

The `isPullRequest` field itself stays in the schema (still useful as descriptive metadata / for any future direct-PR-as-work-item projection), only the policy rejection is removed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/adapters/github-issues-work-source.test.ts`
Expected: PASS

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: PASS (existing tests never exercised the `isPullRequest` branch with `true`, per Task 5's note that current tests already qualify — confirm by reading the test file's fixtures before relying on this; if a test does assert `isPullRequest: true` → `isEligible === false`, update that test's expectation, since a PR-shaped item now never reaches `isEligible` at all).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github/github-issues-work-source.ts src/core/policy-engine.ts test/adapters/github-issues-work-source.test.ts test/core/policy-engine.test.ts
git commit -m "Stop the issues source from emitting PR-shaped items"
```

---

## Task 8: `WorkSource.pollEvents({ watch })` contract + watchlist derivation

**Files:**
- Modify: `src/core/contracts.ts:31-33` (`WorkSource` interface)
- Modify: `src/core/tick-runner.ts` (derive watchlist before polling; pass to `workSource.pollEvents`)
- Modify: `src/core/sink-router.ts:12-19` (`createWorkSourceFanIn` passes `watch` through)
- Modify: `src/adapters/fake/fake-ticketing-system.ts:105` (accept and ignore the arg)
- Modify: `src/adapters/github/github-issues-work-source.ts:357` (accept and ignore the arg)
- Test: `test/core/tick-runner.test.ts`, `test/core/sink-router.test.ts` (check existing file name — may be `test/core/work-source-fan-in.test.ts`; use whichever file already covers `createWorkSourceFanIn`)

**Interfaces:**
- Produces: `WorkSource.pollEvents(input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/tick-runner.test.ts
it('derives the watchlist from correlatedResources and passes it to pollEvents', async () => {
  const pollEvents = vi.fn().mockResolvedValue([]);
  // Build a work source whose pollEvents is the spy above, wire it into a
  // tickRunner alongside a resourceIndex/stateStore pre-seeded (via direct
  // stateStore.writeIssueState, matching this file's existing seeding style)
  // with one open work item whose correlatedResources includes
  // { resourceUri: 'github:pr:org/repo#91', role: 'implementation', relation: 'primary', provenance: 'agent-reported', registeredAt: '...' }.

  await tickRunner.runTick();

  expect(pollEvents).toHaveBeenCalledWith({
    watch: expect.arrayContaining([{ resourceUri: 'github:pr:org/repo#91' }]),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tick-runner.test.ts -t "derives the watchlist"`
Expected: FAIL — `pollEvents` is currently called with no arguments.

- [ ] **Step 3: Update the contract**

In `src/core/contracts.ts`, change:

```typescript
export interface WorkSource {
  pollEvents(): Promise<UnkeyedEventEnvelope[]>;
}
```

to:

```typescript
export interface ResourceRef {
  resourceUri: string;
}

export interface WorkSource {
  pollEvents(input?: { watch: ResourceRef[] }): Promise<UnkeyedEventEnvelope[]>;
}
```

- [ ] **Step 4: Derive the watchlist in `tick-runner.ts`**

Add a helper near `markPendingActionableIssues` (before it, ~line 270):

```typescript
  function deriveWatchlist(projections: IssueStateRecord[]): { resourceUri: string }[] {
    const seen = new Set<string>();
    const watch: { resourceUri: string }[] = [];

    for (const projection of projections) {
      if (projection.issue.state !== 'open') {
        continue;
      }
      for (const resource of projection.correlatedResources) {
        if (seen.has(resource.resourceUri)) {
          continue;
        }
        seen.add(resource.resourceUri);
        watch.push({ resourceUri: resource.resourceUri });
      }
    }

    return watch;
  }
```

In `runTick`, the watchlist must be derived from projections read *before* this tick's poll (a chicken-and-egg is fine — this tick's poll watches what last tick's fold produced; a newly-registered PR is watched starting next tick, which matches the existing pattern where `markPendingActionableIssues` also reads pre-poll `projections`). Reorder the relevant lines (currently lines 822-824):

```typescript
        await reconcileStaleRunningRecords(tickStartedAt);
        await retryUnconfirmedDeliveries();
        const inboundEvents = await ingestInboundEvents(await deps.workSource.pollEvents());

        const projections = await deps.stateStore.listIssueStates();
```

to:

```typescript
        await reconcileStaleRunningRecords(tickStartedAt);
        await retryUnconfirmedDeliveries();
        const watchlistProjections = await deps.stateStore.listIssueStates();
        const inboundEvents = await ingestInboundEvents(
          await deps.workSource.pollEvents({ watch: deriveWatchlist(watchlistProjections) }),
        );

        const projections = await deps.stateStore.listIssueStates();
```

(`projections` is re-read after ingestion, as before — the watchlist read is a separate, earlier snapshot. This costs one extra `listIssueStates()` call per tick; acceptable, matches the existing pattern of re-reading state after mutation elsewhere in this function.)

- [ ] **Step 5: Update `createWorkSourceFanIn`**

In `src/core/sink-router.ts`, change:

```typescript
export function createWorkSourceFanIn(sources: NamedWorkSource[]): WorkSource {
  return {
    async pollEvents(): Promise<UnkeyedEventEnvelope[]> {
      const batches = await Promise.all(sources.map((source) => source.pollEvents()));
      return batches.flat();
    },
  };
}
```

to:

```typescript
export function createWorkSourceFanIn(sources: NamedWorkSource[]): WorkSource {
  return {
    async pollEvents(input): Promise<UnkeyedEventEnvelope[]> {
      const batches = await Promise.all(sources.map((source) => source.pollEvents(input)));
      return batches.flat();
    },
  };
}
```

- [ ] **Step 6: Update the fakes and the issues source to accept (and ignore) the argument**

In `src/adapters/fake/fake-ticketing-system.ts`, change `async pollEvents(): Promise<UnkeyedEventEnvelope[]> {` (line 105) to `async pollEvents(_input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]> {`.

In `src/adapters/github/github-issues-work-source.ts`, change `async pollEvents(): Promise<UnkeyedEventEnvelope[]> {` (line 357) to `async pollEvents(_input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]> {` — the issues source stays a discovery source polling by repo config, per design D-none-needed; it simply ignores the watchlist.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/core/tick-runner.test.ts test/core/sink-router.test.ts` (adjust filename if `createWorkSourceFanIn`'s tests live elsewhere — `grep -rl createWorkSourceFanIn test/` to confirm before running)
Expected: PASS

Run: `npm run build`
Expected: PASS (confirms every `WorkSource` implementer still type-checks against the new optional-arg signature)

- [ ] **Step 8: Commit**

```bash
git add src/core/contracts.ts src/core/tick-runner.ts src/core/sink-router.ts src/adapters/fake/fake-ticketing-system.ts src/adapters/github/github-issues-work-source.ts test/core/tick-runner.test.ts
git commit -m "Add watchlist plumbing to the WorkSource contract"
```

---

## Task 9: `commentSnapshotSchema` gains surface tagging; projection fold accepts PR/review events

**Files:**
- Modify: `src/domain/schema.ts:121-130` (`commentSnapshotSchema`)
- Modify: `src/core/projection-updater.ts:107-136` (comment fold branch)
- Test: `test/core/projection-updater.test.ts` (new case)

**Interfaces:**
- Produces: `commentSnapshotSchema` gains optional `resourceUri: string` and `reviewThread: { path: string; line?: number }`. Projection fold accepts `sourceEventType` values `pr.comment.created`, `pr.review.created`, `pr.review-comment.created` (new, defined in Task 10) using the same shape as `fake.issue.comment.created`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/projection-updater.test.ts — mirror this file's existing
// "folds a comment event" test structure exactly, but with a PR event.
it('folds a PR review-thread comment into comments[] with surface tagging', async () => {
  // Seed a projection via the existing upsert-event path used elsewhere in
  // this file, then fold:
  const commentEvent = createEventEnvelope({
    eventId: 'pr-review-comment-1',
    workItemKey,
    streamScope: 'work-item',
    direction: 'inbound',
    sourceSystem: 'github-pr',
    sourceEventType: 'pr.review-comment.created',
    sourceRefs: { resourceUri: 'github:pr-review-thread:org/repo#91/rt_1' },
    occurredAt: '2026-07-18T00:00:00Z',
    ingestedAt: '2026-07-18T00:00:00Z',
    trigger: 'context-only',
    payload: {
      comment: {
        id: 'rc-1',
        body: 'Please fix this null check',
        author: { login: 'reviewer' },
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T00:00:00Z',
        resourceUri: 'github:pr-review-thread:org/repo#91/rt_1',
        reviewThread: { path: 'src/foo.ts', line: 42 },
      },
    },
    derivedHints: { botAuthoredComment: false },
  });

  await projectionUpdater.rebuildFromEvents([commentEvent]);
  const projection = await stateStore.readIssueState(workItemKey);
  const comment = projection?.comments.find((c) => c.id === 'rc-1');
  expect(comment?.resourceUri).toBe('github:pr-review-thread:org/repo#91/rt_1');
  expect(comment?.reviewThread).toEqual({ path: 'src/foo.ts', line: 42 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/projection-updater.test.ts -t "review-thread comment"`
Expected: FAIL — `pr.review-comment.created` isn't a recognized `sourceEventType` in `applyEvent`, so the fold falls through to the generic no-op branch and the comment never appears.

- [ ] **Step 3: Extend the schema**

In `src/domain/schema.ts`, modify `commentSnapshotSchema` (lines 121-130):

```typescript
const reviewThreadAnchorSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
});

const commentSnapshotSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({
    login: z.string(),
  }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  isBotAuthored: z.boolean().default(false),
  // Which correlated surface this comment came from; absent = the originating
  // issue thread, keeping every pre-existing comment valid under this schema.
  resourceUri: resourceUriSchema.optional(),
  reviewThread: reviewThreadAnchorSchema.optional(),
});
```

- [ ] **Step 4: Extend the projection fold**

In `src/core/projection-updater.ts`, modify the comment-fold condition (lines 107-111) to also match the new PR event types:

```typescript
  if (
    event.sourceEventType === 'fake.issue.comment.created' ||
    event.sourceEventType === 'ticket.comment.created' ||
    event.sourceEventType === 'ticket.comment.updated' ||
    event.sourceEventType === 'pr.comment.created' ||
    event.sourceEventType === 'pr.review.created' ||
    event.sourceEventType === 'pr.review-comment.created'
  ) {
```

The rest of that branch (lines 112-136) already reads `event.payload.comment` generically and spreads it into the projection, so `resourceUri`/`reviewThread` on the payload's `comment` object pass through unchanged — no further change needed there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core/projection-updater.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/domain/schema.ts src/core/projection-updater.ts test/core/projection-updater.test.ts
git commit -m "Fold PR/review comments into comments[] with surface tagging"
```

---

## Task 10: `createGitHubPullRequestActivitySource` — discovery + watchlisted activity polling

**Design note (deviation from the design doc, discovered during planning):** the design doc's §3/§4 assume the PR source only polls watchlisted PRs. That alone can never surface a *new*, uncorrelated PR for qualification (Task 5/6) — nothing would ever call the resolver with a fresh `github:pr:…` URI. This task adds a lightweight **discovery** pass, symmetric to `github-issues-work-source.ts`'s repo-level `listIssues` polling: for each configured repo, list open PRs and emit one lightweight `pr.seen` event per PR not already known, carrying just enough (`author`, `headRef`) for `qualifiesForMint`. `pr.seen` events use a **stable, timestamp-free `eventId`** (`pr-seen-<repo>-<number>`) so `appendEventEnvelope`'s id-dedup naturally caps this to one append ever per PR — it is not re-emitted every tick once the PR is either minted or parked.

**Files:**
- Create: `src/adapters/github/github-pull-request-activity-source.ts`
- Create: `src/adapters/fake/fake-github-pull-request-activity-source.ts`
- Test: `test/adapters/github-pull-request-activity-source.test.ts`

**Interfaces:**
- Consumes: `github-client.ts`'s `listPullRequests`, `getPullRequest`, `listComments`, `listReviews`, `listReviewComments`, `replyToReviewComment` (Task 3); `buildResourceUri` (existing); `WorkSource`/`OutboundSink` contracts (Task 8).
- Produces: `createGitHubPullRequestActivitySource(deps): WorkSource & OutboundSink`, registered in `main.ts` (Task 12) as a second named source/sink.

- [ ] **Step 1: Write the failing test**

```typescript
// test/adapters/github-pull-request-activity-source.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createGitHubPullRequestActivitySource } from '../../src/adapters/github/github-pull-request-activity-source.js';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
// Reuse this repo's stateStore test-fixture helper (check
// test/adapters/github-issues-work-source.test.ts for how it builds a
// throwaway stateStore under a temp wakeRoot) rather than inventing a new one.

describe('createGitHubPullRequestActivitySource', () => {
  it('discovers open PRs not yet correlated and emits a pr.seen event per PR', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([
        { number: 91, html_url: 'https://github.com/org/repo/pull/91', user: { login: 'trusted-human' }, head: { ref: 'feature-x' }, updated_at: '2026-07-18T00:00:00Z' },
      ]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
    };
    const resourceIndex = createFakeResourceIndex();
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore /* fixture */,
      config: /* config with sources.github.repos: ['org/repo'], sources.github.pullRequests.enabled: true */,
      resourceIndex,
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [] });
    const seenEvents = events.filter((e) => e.sourceEventType === 'pr.seen');
    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]?.sourceRefs.resourceUri).toBe('github:pr:org/repo#91');
    expect(seenEvents[0]?.payload.pr).toEqual({ number: 91, author: 'trusted-human', headRef: 'feature-x' });
  });

  it('does not re-emit pr.seen once the PR is already correlated', async () => {
    // Same client/config as above, but resourceIndex already has
    // 'github:pr:org/repo#91' -> some workItemKey registered.
    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    expect(events.filter((e) => e.sourceEventType === 'pr.seen')).toHaveLength(0);
  });

  it('polls conversation comments, reviews, and review comments only for watchlisted PRs', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([
        { id: 1, body: 'LGTM modulo one thing', user: { login: 'reviewer' }, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', html_url: 'https://github.com/org/repo/pull/91#issuecomment-1' },
      ]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
    };
    const source = createGitHubPullRequestActivitySource({ client, stateStore, config, resourceIndex, now: () => new Date('2026-07-18T00:00:00Z') });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    expect(client.listComments).toHaveBeenCalledWith('org', 'repo', 91, expect.any(Number));
    const commentEvents = events.filter((e) => e.sourceEventType === 'pr.comment.created');
    expect(commentEvents).toHaveLength(1);
    expect(commentEvents[0]?.sourceRefs.resourceUri).toBe('github:pr:org/repo#91');
  });

  it('derives a stable review-thread resourceUri from review comment thread roots', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([
        { id: 501, in_reply_to_id: undefined, path: 'src/foo.ts', line: 42, body: 'root comment', user: { login: 'reviewer' }, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', html_url: 'https://github.com/org/repo/pull/91#discussion_r501' },
        { id: 502, in_reply_to_id: 501, path: 'src/foo.ts', line: 42, body: 'reply', user: { login: 'author' }, created_at: '2026-07-18T00:01:00Z', updated_at: '2026-07-18T00:01:00Z', html_url: 'https://github.com/org/repo/pull/91#discussion_r502' },
      ]),
      replyToReviewComment: vi.fn(),
    };
    const source = createGitHubPullRequestActivitySource({ client, stateStore, config, resourceIndex, now: () => new Date('2026-07-18T00:00:00Z') });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    const threadEvents = events.filter((e) => e.sourceEventType === 'pr.review-comment.created');
    expect(threadEvents).toHaveLength(2);
    expect(threadEvents[0]?.sourceRefs.resourceUri).toBe('github:pr-review-thread:org/repo#91/rt_501');
    expect(threadEvents[1]?.sourceRefs.resourceUri).toBe('github:pr-review-thread:org/repo#91/rt_501');
    expect((threadEvents[0]?.payload.comment as { reviewThread: { path: string; line: number } }).reviewThread).toEqual({ path: 'src/foo.ts', line: 42 });
  });
});
```

(Fill in the `stateStore`/`config` fixtures using this repo's existing pattern from `test/adapters/github-issues-work-source.test.ts` — read that file's `beforeEach`/fixture setup first, since it already builds a disposable `stateStore` under a temp dir and a matching `WakeConfig`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/github-pull-request-activity-source.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the source**

```typescript
// src/adapters/github/github-pull-request-activity-source.ts
import type { ResourceIndex, UnkeyedEventEnvelope } from '../../core/contracts.js';
import type { EventEnvelope, WakeConfig } from '../../domain/types.js';
import { buildResourceUri } from '../../domain/resource-uri.js';
import { createUnkeyedEventEnvelope, createEventEnvelope } from '../../lib/event-log.js';

const githubPrSource = 'github-pr';
const wakeCommentMarker = '<!-- wake:agent -->';

type GitHubPullRequest = {
  number: number;
  html_url: string;
  user: { login?: string } | null;
  head: { ref: string };
  updated_at: string;
};

type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

type GitHubReview = {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  submitted_at?: string;
  html_url?: string;
  state: string;
};

type GitHubReviewComment = {
  id: number;
  in_reply_to_id?: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

function prResourceUri(repo: string, number: number): string {
  return buildResourceUri('github', 'pr', `${repo}#${number}`);
}

function reviewThreadRootId(comment: GitHubReviewComment, byId: Map<number, GitHubReviewComment>): number {
  let current = comment;
  const visited = new Set<number>();
  while (current.in_reply_to_id !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.in_reply_to_id);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current.id;
}

function reviewThreadResourceUri(repo: string, prNumber: number, rootId: number): string {
  return buildResourceUri('github', 'pr-review-thread', `${repo}#${prNumber}/rt_${rootId}`);
}

function isBotAuthored(comment: { user?: { type?: string } | null; body?: string }): boolean {
  return comment.user?.type === 'Bot' || (comment.body ?? '').includes(wakeCommentMarker);
}

export function createGitHubPullRequestActivitySource(deps: {
  client: {
    listPullRequests: (owner: string, repo: string, maxResults: number) => Promise<GitHubPullRequest[]>;
    getPullRequest: (owner: string, repo: string, pullNumber: number) => Promise<GitHubPullRequest>;
    listComments: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubComment[]>;
    listReviews: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubReview[]>;
    listReviewComments: (owner: string, repo: string, prNumber: number, perPage: number) => Promise<GitHubReviewComment[]>;
    replyToReviewComment: (owner: string, repo: string, prNumber: number, commentId: number, body: string) => Promise<unknown>;
  };
  stateStore: ReturnType<typeof import('../fs/state-store.js').createStateStore>;
  config: WakeConfig;
  resourceIndex: ResourceIndex;
  now: () => Date;
}) {
  function repoAndNumberFromPrUri(resourceUri: string): { owner: string; repo: string; repoRef: string; number: number } | null {
    // github:pr:<owner>/<repo>#<number>
    const locator = resourceUri.split(':').slice(2).join(':');
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(locator);
    if (match === null) {
      return null;
    }
    const [, owner, repo, numberStr] = match;
    if (owner === undefined || repo === undefined || numberStr === undefined) {
      return null;
    }
    return { owner, repo, repoRef: `${owner}/${repo}`, number: Number(numberStr) };
  }

  async function discoverPullRequests(ingestedAt: string): Promise<UnkeyedEventEnvelope[]> {
    if (!deps.config.sources.github.pullRequests.enabled) {
      return [];
    }

    const events: UnkeyedEventEnvelope[] = [];
    for (const repoRef of deps.config.sources.github.repos) {
      const [owner, repo] = repoRef.split('/');
      if (owner === undefined || repo === undefined) {
        continue;
      }

      try {
        const prs = await deps.client.listPullRequests(
          owner,
          repo,
          deps.config.sources.github.pullRequests.maxPullRequestsPerRepo,
        );

        for (const pr of prs) {
          const resourceUri = prResourceUri(repoRef, pr.number);
          const known = await deps.resourceIndex.resolve(resourceUri);
          if (known !== undefined) {
            continue;
          }

          events.push(
            createUnkeyedEventEnvelope({
              // Stable, timestamp-free id: appendEventEnvelope dedups on this,
              // so a PR that never qualifies is only ever appended once, not
              // every tick.
              eventId: `pr-seen-${repoRef.replace(/[^a-z0-9]+/gi, '-')}-${pr.number}`,
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: githubPrSource,
              sourceEventType: 'pr.seen',
              sourceRefs: { repo: repoRef, sourceUrl: pr.html_url, resourceUri },
              occurredAt: pr.updated_at,
              ingestedAt,
              trigger: 'context-only',
              payload: {
                pr: { number: pr.number, author: pr.user?.login ?? 'unknown', headRef: pr.head.ref },
              },
            }),
          );
        }
      } catch (error) {
        console.error(
          `[github-pr-activity-source] discovery failed for ${repoRef}, skipping this tick: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return events;
  }

  async function pollWatchedPr(
    resourceUri: string,
    ingestedAt: string,
  ): Promise<UnkeyedEventEnvelope[]> {
    const ref = repoAndNumberFromPrUri(resourceUri);
    if (ref === null) {
      return [];
    }

    const events: UnkeyedEventEnvelope[] = [];
    const perPage = deps.config.sources.github.pullRequests.commentPageSize;

    try {
      const comments = await deps.client.listComments(ref.owner, ref.repo, ref.number, perPage);
      for (const comment of comments) {
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-comment-${ref.repoRef}-${ref.number}-${comment.id}-${comment.updated_at}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.comment.created',
            sourceRefs: { repo: ref.repoRef, commentId: String(comment.id), sourceUrl: comment.html_url, resourceUri },
            occurredAt: comment.updated_at,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-${comment.id}`,
                body: comment.body ?? '',
                author: { login: comment.user?.login ?? 'unknown' },
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                resourceUri,
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(comment) },
          }),
        );
      }

      const reviews = await deps.client.listReviews(ref.owner, ref.repo, ref.number, perPage);
      for (const review of reviews) {
        if (review.body === undefined || review.body === null || review.body.trim().length === 0) {
          continue;
        }
        const submittedAt = review.submitted_at ?? ingestedAt;
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-review-${ref.repoRef}-${ref.number}-${review.id}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review.created',
            sourceRefs: { repo: ref.repoRef, commentId: `review-${review.id}`, sourceUrl: review.html_url, resourceUri },
            occurredAt: submittedAt,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-review-${review.id}`,
                body: `[${review.state}] ${review.body}`,
                author: { login: review.user?.login ?? 'unknown' },
                createdAt: submittedAt,
                updatedAt: submittedAt,
                resourceUri,
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(review) },
          }),
        );
      }

      const reviewComments = await deps.client.listReviewComments(ref.owner, ref.repo, ref.number, perPage);
      const byId = new Map(reviewComments.map((c) => [c.id, c]));
      for (const comment of reviewComments) {
        const rootId = reviewThreadRootId(comment, byId);
        const threadUri = reviewThreadResourceUri(ref.repoRef, ref.number, rootId);
        events.push(
          createUnkeyedEventEnvelope({
            eventId: `pr-review-comment-${ref.repoRef}-${ref.number}-${comment.id}-${comment.updated_at}`,
            streamScope: 'work-item',
            direction: 'inbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review-comment.created',
            sourceRefs: { repo: ref.repoRef, commentId: String(comment.id), sourceUrl: comment.html_url, resourceUri: threadUri },
            occurredAt: comment.updated_at,
            ingestedAt,
            trigger: 'context-only',
            payload: {
              comment: {
                id: `pr-review-comment-${comment.id}`,
                body: comment.body ?? '',
                author: { login: comment.user?.login ?? 'unknown' },
                createdAt: comment.created_at,
                updatedAt: comment.updated_at,
                resourceUri: threadUri,
                reviewThread: { path: comment.path, line: comment.line ?? comment.original_line ?? undefined },
              },
            },
            derivedHints: { botAuthoredComment: isBotAuthored(comment) },
          }),
        );
      }
    } catch (error) {
      console.error(
        `[github-pr-activity-source] activity poll failed for ${resourceUri}, skipping this tick: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return events;
  }

  return {
    async pollEvents(input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]> {
      const ingestedAt = deps.now().toISOString();
      const watched = (input?.watch ?? []).filter((ref) => ref.resourceUri.startsWith('github:pr:'));

      const discovered = await discoverPullRequests(ingestedAt);
      const activityBatches = await Promise.all(
        watched.map((ref) => pollWatchedPr(ref.resourceUri, ingestedAt)),
      );

      return [...discovered, ...activityBatches.flat()];
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const resourceUri = input.event.sourceRefs.resourceUri;
      if (resourceUri === undefined) {
        throw new Error(`cannot deliver intent ${input.event.eventId}: missing sourceRefs.resourceUri`);
      }

      const publishedAt = deps.now().toISOString();

      if (resourceUri.startsWith('github:pr-review-thread:')) {
        const locator = resourceUri.split(':').slice(2).join(':');
        const match = /^([^/]+)\/([^#]+)#(\d+)\/rt_(\d+)$/.exec(locator);
        if (match === null) {
          throw new Error(`cannot deliver intent ${input.event.eventId}: malformed review-thread uri ${resourceUri}`);
        }
        const [, owner, repo, numberStr, rootIdStr] = match;
        if (owner === undefined || repo === undefined || numberStr === undefined || rootIdStr === undefined) {
          throw new Error(`cannot deliver intent ${input.event.eventId}: malformed review-thread uri ${resourceUri}`);
        }

        const body = typeof input.event.payload.body === 'string' ? input.event.payload.body : '';
        const response = await deps.client.replyToReviewComment(
          owner,
          repo,
          Number(numberStr),
          Number(rootIdStr),
          `${wakeCommentMarker}\n\n${body}`,
        );

        return [
          createEventEnvelope({
            eventId: `${input.event.eventId}-published`,
            workItemKey: input.event.workItemKey,
            streamScope: 'work-item',
            direction: 'outbound',
            sourceSystem: githubPrSource,
            sourceEventType: 'pr.review-comment.reply.published',
            sourceRefs: { resourceUri, sourceUrl: (response as { html_url?: string } | undefined)?.html_url },
            occurredAt: publishedAt,
            ingestedAt: publishedAt,
            trigger: 'context-only',
            payload: { intentEventId: input.event.eventId, kind: input.event.payload.kind, body: input.event.payload.body },
          }),
        ];
      }

      const ref = repoAndNumberFromPrUri(resourceUri);
      if (ref === null) {
        throw new Error(`cannot deliver intent ${input.event.eventId}: malformed pr uri ${resourceUri}`);
      }

      const body = typeof input.event.payload.body === 'string' ? input.event.payload.body : '';
      await deps.client.listComments; // no-op reference to keep type surface honest; actual create is below
      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-published`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: githubPrSource,
          sourceEventType: 'pr.comment.reply.published',
          sourceRefs: { repo: ref.repoRef, resourceUri },
          occurredAt: publishedAt,
          ingestedAt: publishedAt,
          trigger: 'context-only',
          payload: { intentEventId: input.event.eventId, kind: input.event.payload.kind, body: input.event.payload.body },
        }),
      ];
    },
  };
}
```

**Correction before running tests:** the `deliverIntent` PR-conversation branch above stubs the actual comment creation with a no-op placeholder line (`await deps.client.listComments;`) — that is a bug, not a placeholder to leave in. Replace it: add `createComment` to the `deps.client` type in this file's signature (`createComment: (owner: string, repo: string, prNumber: number, body: string) => Promise<unknown>;`), wire it to `github-client.ts`'s existing `createComment` (already implemented for issues — PR conversation comments use the identical REST endpoint, so no new client method is needed, just reuse `createComment` from Task 3's `deps.client` shape), and call `await deps.client.createComment(ref.owner, ref.repo, ref.number, \`${wakeCommentMarker}\n\n${body}\`)` in place of the stub line before constructing the returned envelope.

- [ ] **Step 4: Add the fake**

```typescript
// src/adapters/fake/fake-github-pull-request-activity-source.ts
import type { UnkeyedEventEnvelope } from '../../core/contracts.js';
import type { EventEnvelope } from '../../domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../lib/event-log.js';

export interface FakePrActivitySeed {
  repo: string;
  number: number;
  author: string;
  headRef: string;
  comments: Array<{ id: string; body: string; author: string }>;
}

/** Permanent test harness — zero-token equivalent of the real GitHub PR activity source. */
export function createFakeGitHubPullRequestActivitySource(options: {
  prs: FakePrActivitySeed[];
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async pollEvents(input?: { watch: Array<{ resourceUri: string }> }): Promise<UnkeyedEventEnvelope[]> {
      const nowIso = now().toISOString();
      const watched = new Set((input?.watch ?? []).map((ref) => ref.resourceUri));
      const events: UnkeyedEventEnvelope[] = [];

      for (const pr of options.prs) {
        const resourceUri = `github:pr:${pr.repo}#${pr.number}`;

        if (!watched.has(resourceUri)) {
          events.push(
            createUnkeyedEventEnvelope({
              eventId: `fake-pr-seen-${pr.repo}-${pr.number}`,
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'fake-github-pr',
              sourceEventType: 'pr.seen',
              sourceRefs: { repo: pr.repo, resourceUri },
              occurredAt: nowIso,
              ingestedAt: nowIso,
              trigger: 'context-only',
              payload: { pr: { number: pr.number, author: pr.author, headRef: pr.headRef } },
            }),
          );
          continue;
        }

        for (const comment of pr.comments) {
          events.push(
            createUnkeyedEventEnvelope({
              eventId: `fake-pr-comment-${pr.repo}-${pr.number}-${comment.id}`,
              streamScope: 'work-item',
              direction: 'inbound',
              sourceSystem: 'fake-github-pr',
              sourceEventType: 'pr.comment.created',
              sourceRefs: { repo: pr.repo, commentId: comment.id, resourceUri },
              occurredAt: nowIso,
              ingestedAt: nowIso,
              trigger: 'context-only',
              payload: {
                comment: {
                  id: comment.id,
                  body: comment.body,
                  author: { login: comment.author },
                  createdAt: nowIso,
                  updatedAt: nowIso,
                  resourceUri,
                },
              },
              derivedHints: { botAuthoredComment: false },
            }),
          );
        }
      }

      return events;
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const publishedAt = now().toISOString();
      return [
        createEventEnvelope({
          eventId: `${input.event.eventId}-published`,
          workItemKey: input.event.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'fake-github-pr',
          sourceEventType: 'pr.comment.reply.published',
          sourceRefs: { ...input.event.sourceRefs, sink: 'fake-github-pr' },
          occurredAt: publishedAt,
          ingestedAt: publishedAt,
          trigger: 'context-only',
          payload: { intentEventId: input.event.eventId, kind: input.event.payload.kind, body: input.event.payload.body },
        }),
      ];
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/adapters/github-pull-request-activity-source.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github/github-pull-request-activity-source.ts src/adapters/fake/fake-github-pull-request-activity-source.ts test/adapters/github-pull-request-activity-source.test.ts
git commit -m "Add GitHub PR activity source: discovery + watchlisted polling"
```

---

## Task 11: Sink routing by `resourceUri`

**Files:**
- Modify: `src/core/sink-router.ts:52-103` (`createOutboundSinkRouter`)
- Test: whichever existing test file covers `createOutboundSinkRouter` (locate via `grep -rl createOutboundSinkRouter test/`)

**Interfaces:**
- Consumes: `sourceRefs.resourceUri` (existing field).
- Produces: routing behavior only — no signature change to `OutboundSink` or `createOutboundSinkRouter`'s own signature.

- [ ] **Step 1: Write the failing test**

```typescript
it('routes a publish intent targeting a PR resource to the github-pr sink', async () => {
  const githubSink = { sink: 'github', deliverIntent: vi.fn().mockResolvedValue([]) };
  const githubPrSink = { sink: 'github-pr', deliverIntent: vi.fn().mockResolvedValue([]) };
  const router = createOutboundSinkRouter({ sinks: [githubSink, githubPrSink], config: /* minimal WakeConfig with sinks: {} */ });

  await router.deliverIntent({
    event: createEventEnvelope({
      eventId: 'e1',
      workItemKey: 'work-1',
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
      occurredAt: '2026-07-18T00:00:00Z',
      ingestedAt: '2026-07-18T00:00:00Z',
      trigger: 'context-only',
      payload: { kind: 'status-update', origin: 'github', body: 'hi' },
    }),
  });

  expect(githubPrSink.deliverIntent).toHaveBeenCalled();
  expect(githubSink.deliverIntent).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <path> -t "routes a publish intent targeting a PR resource"`
Expected: FAIL — currently routes only by `sourceRefs.sink ?? payload.origin`, which is `'github'`, not `'github-pr'`.

- [ ] **Step 3: Implement**

In `src/core/sink-router.ts`, modify `deliverIntent` (lines 59-101). Add a helper above `createOutboundSinkRouter` (after `withSinkRef`, ~line 50):

```typescript
function sinkNameForResourceUri(resourceUri: string, fallback: string): string {
  const [provider, kind] = resourceUri.split(':');
  if (provider === undefined || kind === undefined) {
    return fallback;
  }
  return kind === 'pr' || kind === 'pr-review-thread' ? `${provider}-pr` : fallback;
}
```

In the `deliverIntent` body, after the existing `sourceOrigin`/`targetSinks.add(sourceOrigin)` block (lines 73-79), change the target-add logic so a present `resourceUri` overrides the origin-derived sink name for the default single-trigger case:

```typescript
      const kind = intentKind(event);
      const resourceUri = event.sourceRefs.resourceUri;
      if (
        event.sourceEventType === 'wake.publish.intent.requested' &&
        sourceOrigin !== undefined
      ) {
        targetSinks.add(
          resourceUri === undefined ? sourceOrigin : sinkNameForResourceUri(resourceUri, sourceOrigin),
        );
      }
```

(This replaces the existing 4-line block at lines 73-79 that just does `targetSinks.add(sourceOrigin)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <that test file>`
Expected: PASS, no regressions (issue-thread replies have no `resourceUri` of kind `pr`/`pr-review-thread`, or none at all, so `sinkNameForResourceUri` falls back to `sourceOrigin` — identical to today's behavior).

- [ ] **Step 5: Commit**

```bash
git add src/core/sink-router.ts <test file>
git commit -m "Route publish intents to PR surfaces by resourceUri"
```

---

## Task 12: Wire the PR source/sink into `main.ts`

**Files:**
- Modify: `src/main.ts:203-288` (`buildRuntime`)

**Interfaces:**
- No new exported interfaces — wiring only.

- [ ] **Step 1: Write the failing test**

This task is wiring with no independently testable unit; skip straight to implementation, then verify via the existing CLI/integration tests in `test/cli/main.test.ts` (run them after the change to confirm no regression — do not add a new test here, since `buildRuntime` is already covered end-to-end by those).

- [ ] **Step 2: Implement**

In `src/main.ts`, add the import near the other adapter imports:

```typescript
import { createGitHubPullRequestActivitySource } from './adapters/github/github-pull-request-activity-source.js';
```

In `buildRuntime`, after the existing `ticketingSystem`/`sourceName`/`sinkName` block (lines 218-246), add:

```typescript
  const pullRequestActivitySource = config.sources.github.enabled
    ? createGitHubPullRequestActivitySource({
        client: createGitHubClient(await resolveGitHubToken()),
        stateStore,
        config,
        resourceIndex,
        now: () => systemClock.now(),
      })
    : null;
```

Change the `workSource` construction (lines 232-237) to fan in the second source when present:

```typescript
  const workSource = createWorkSourceFanIn([
    {
      source: sourceName,
      pollEvents: ticketingSystem.pollEvents,
    },
    ...(pullRequestActivitySource === null
      ? []
      : [{ source: 'github-pr', pollEvents: pullRequestActivitySource.pollEvents }]),
  ]);
```

Change the `outboundSink` construction (lines 238-246) to register the PR sink alongside the existing one:

```typescript
  const outboundSink = createOutboundSinkRouter({
    sinks: [
      {
        sink: sinkName,
        deliverIntent: ticketingSystem.deliverIntent,
      },
      ...(pullRequestActivitySource === null
        ? []
        : [{ sink: 'github-pr', deliverIntent: pullRequestActivitySource.deliverIntent }]),
    ],
    config,
  });
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `npx vitest run test/cli/main.test.ts`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "Wire the GitHub PR activity source into buildRuntime"
```

---

## Task 13: Resume prompt renders surface + review-thread anchoring

**Files:**
- Modify: `src/adapters/runner/stage-prompt.ts:12-22` (`formatComment`)
- Test: `test/adapters/prompt-templates.test.ts`

**Interfaces:**
- No signature change — rendering only.

- [ ] **Step 1: Write the failing test**

```typescript
it('renders review-thread anchoring for a PR review comment', async () => {
  const result = await buildStagePrompt({
    action: 'implement',
    mode: 'resume',
    projection: {
      /* ...base fixture..., */
      comments: [
        {
          id: 'rc-1',
          body: 'Please fix this null check',
          author: { login: 'reviewer' },
          createdAt: '2026-07-18T00:00:00Z',
          updatedAt: '2026-07-18T00:00:00Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:org/repo#91/rt_1',
          reviewThread: { path: 'src/foo.ts', line: 42 },
        },
      ],
    },
  });

  expect(result.prompt).toContain('src/foo.ts:42');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/prompt-templates.test.ts -t "review-thread anchoring"`
Expected: FAIL — `formatComment` doesn't render `reviewThread`.

- [ ] **Step 3: Implement**

In `src/adapters/runner/stage-prompt.ts`, modify `formatComment` (lines 12-22):

```typescript
function formatComment(comment: CommentSnapshot): string {
  const surfaceLine = comment.reviewThread !== undefined
    ? `Surface: review comment on ${comment.reviewThread.path}${comment.reviewThread.line === undefined ? '' : `:${comment.reviewThread.line}`}`
    : comment.resourceUri !== undefined
      ? `Surface: ${comment.resourceUri}`
      : 'Surface: issue thread';

  return [
    '<wake-comment>',
    `Author: ${comment.author.login}`,
    `Created: ${comment.createdAt}`,
    `Bot-authored: ${comment.isBotAuthored ? 'yes' : 'no'}`,
    surfaceLine,
    'Body:',
    comment.body,
    '</wake-comment>',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/prompt-templates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/runner/stage-prompt.ts test/adapters/prompt-templates.test.ts
git commit -m "Render surface and review-thread anchoring in the resume prompt"
```

---

## Task 14: End-to-end fake-adapter scenario

**Files:**
- Test: `test/core/tick-runner.test.ts` (new describe block — the confirmation scenario from ADR 0001's "Confirmation" section and the design doc's phase 8)

**Interfaces:**
- Consumes: everything above. No production code changes in this task unless the scenario surfaces a gap — if so, fix it in the relevant existing file and note the fix in the commit message rather than opening a new task.

- [ ] **Step 1: Write the scenario test**

```typescript
describe('end-to-end: issue -> implement -> PR review comment -> resume -> reply on the thread', () => {
  it('resumes the issue work item from a PR review comment and replies on the review thread', async () => {
    // 1. Seed a fake ticket already in 'implement' stage with a prior session
    //    (mirror this file's existing implement-stage fixture).
    // 2. First tick: fake runner reports a wake-artifacts PR (Task 4's fixture
    //    pattern) and AWAITING_APPROVAL. Use a fake artifact verifier that
    //    verifies https://example.test/org/repo/pull/91 -> github:pr:org/repo#91.
    // 3. Assert projection.correlatedResources contains the PR with role
    //    'implementation', provenance 'agent-reported'.
    // 4. Approve (post a human /approved comment via the fake ticketing
    //    system's normal comment-seed path) so the work item stays in
    //    'implement' with a live session, matching this file's existing
    //    approval-flow fixtures.
    // 5. Configure a fake PR activity source (Task 10) seeded with one PR
    //    (org/repo#91) carrying one review-thread comment; build the
    //    tickRunner with a workSource fan-in of [fake ticketing, fake PR
    //    activity source] and an outboundSink router with both fakes' sinks
    //    registered under 'fake-ticketing' and 'fake-github-pr'.
    // 6. Second tick: the watchlist now includes github:pr:org/repo#91 (from
    //    step 3's registration), so the fake PR source emits the review
    //    comment; assert the work item resumes (same sessionId as before),
    //    and that the resulting publish-intent event carries
    //    sourceRefs.resourceUri === 'github:pr-review-thread:org/repo#91/rt_...'.
    // 7. Assert the delivered reply event's sourceEventType is
    //    'pr.review-comment.reply.published' (routed to the PR sink, not the
    //    issue sink).
  });
});
```

Write out this scenario fully against the actual fixtures already present in `test/core/tick-runner.test.ts` — the outline above names every assertion point; do not leave any of the seven steps as a comment in the committed test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tick-runner.test.ts -t "end-to-end"`
Expected: FAIL initially while the scenario is being assembled; iterate until each assertion is real.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — every test in the repo, not just the new ones.

- [ ] **Step 4: Run verify**

Run: `npm run verify`
Expected: PASS (build + test)

- [ ] **Step 5: Commit**

```bash
git add test/core/tick-runner.test.ts
git commit -m "Add end-to-end PR review-comment resume scenario"
```

---

## Task 15: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document the new config surface**

In `docs/configuration.md`, add a section documenting `sources.github.pullRequests` (`enabled`, `maxPullRequestsPerRepo`, `commentPageSize`, `policy.requiredAuthors`), following the existing style used for `sources.github.policy`. State explicitly that `requiredAuthors` defaults to empty (no standalone PR adoption until configured) and that PR activity on a PR already correlated to a work item (e.g. one Wake's own agent opened) needs no config at all.

- [ ] **Step 2: Document the source in the architecture doc**

In `docs/architecture.md`, add a short paragraph near the existing `WorkSource`/adapter description noting the second GitHub source (`github-pr`), that it is watchlist-driven off `correlatedResources[]` for activity but does its own lightweight repo-level discovery for qualification, and link to `docs/superpowers/specs/2026-07-18-pr-activity-source-design.md`.

- [ ] **Step 3: Update README if it lists source config**

Check `README.md` for an existing `sources.github` config example; if present, add `pullRequests` to it matching the same shape as `docs/configuration.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/configuration.md docs/architecture.md
git commit -m "Document the PR activity source configuration"
```

---

## Self-Review Notes

* **Spec coverage:** D1' → Tasks 5-6. D2 → Task 7. D3 → no task (confirmed no code change needed; the existing `sessionId`-presence resume rule already generalizes once Task 9 lands). D4 → Task 13 (anchoring only, no materialization added anywhere in this plan). D5 → Task 9. §1 (artifacts) → Tasks 1-2, 4. §2 (mint qualification) → Tasks 5-6. §3 (PR source) → Task 10. §4 (watchlist) → Task 8. §5 (routing) → Task 11. §6 (prompt) → Task 13. Sequencing phases 1-8 → Tasks 1-2 / 5-6 / 7 / 8 / 10 / 9 / 11 / 13-14 respectively (task numbers don't map 1:1 to phase numbers because Task 3's client methods and Task 4's verifier were split out of "phase 1" for independent testability, and Task 12's wiring was made explicit).
* **Discovery gap:** flagged in Task 10's design note — this is new relative to the approved design doc and should be called out to the user when this plan is handed back for review, not silently included.
* **Type consistency check:** `ArtifactVerifier.verify` (Task 4) takes `ReportedArtifact` (Task 1) — confirmed same shape. `qualifiesForMint` (Task 5) takes `UnkeyedEventEnvelope` — confirmed this is the same type `resolveInboundEvent` (Task 6) already handles. `WorkSource.pollEvents({ watch })` (Task 8) — confirmed the PR source (Task 10), the issues source (Task 7), and both fakes all implement the same optional-arg signature. `commentSnapshotSchema`'s `resourceUri`/`reviewThread` (Task 9) — confirmed `stage-prompt.ts`'s `CommentSnapshot` type alias (`IssueStateRecord['comments'][number]`, Task 13) picks up the new fields automatically since it's derived from the schema, not redeclared.
* **No placeholders:** one was caught and fixed inline during drafting — Task 10 Step 3's `deliverIntent` PR-conversation branch initially stubbed comment creation; the step's own "Correction" paragraph replaces it with real `client.createComment` wiring before the task is considered complete.

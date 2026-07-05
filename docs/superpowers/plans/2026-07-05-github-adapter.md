# GitHub Issues Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real GitHub Issues ticketing source that syncs issues into Wake through canonical ticket events, applies Wake-owned label policy, and invokes Eddy through either the fake or Claude runner when actionable ticket changes arrive.

**Architecture:** Keep GitHub Issues transport in a new adapter that resolves a token via `gh auth token` and uses Octokit for structured reads and writes. The adapter must translate provider-specific payloads into canonical Wake ticket events before they enter core. Let `tick` remain the single durable control-plane cycle: poll GitHub Issues, append canonical ticket events, rebuild projections, select actionable work, invoke the configured runner, and publish minimal ticket status back out.

**Tech Stack:** TypeScript, Node.js, Vitest, Zod, Octokit, GitHub CLI authentication bridge

---

## File Structure

### New files

- `src/adapters/github/github-auth.ts`
  - resolves a GitHub token by invoking `gh auth token`
- `src/adapters/github/github-client.ts`
  - constructs Octokit and wraps issue/comment list and comment publication calls
- `src/adapters/github/github-issues-work-source.ts`
  - polls GitHub Issues, applies coarse source filters, compares remote snapshots to local state, and emits canonical Wake ticket events
- `test/adapters/github-auth.test.ts`
  - covers `gh auth token` success and failure cases
- `test/adapters/github-issues-work-source.test.ts`
  - covers incremental sync, canonical ticket-event translation, and outbound GitHub publication
- `docs/superpowers/plans/2026-07-05-github-adapter.md`
  - this implementation plan

### Modified files

- `package.json`
  - add Octokit dependency
- `src/domain/schema.ts`
  - extend config schema and issue-state schema for GitHub source and sync metadata
- `src/domain/types.ts`
  - expose the new config and metadata types
- `src/config/defaults.ts`
  - add default GitHub Issues source configuration
- `src/config/load-config.ts`
  - merge nested GitHub Issues source configuration safely
- `src/lib/paths.ts`
  - add durable path helpers for per-source sync state files
- `src/core/contracts.ts`
  - keep `WorkSource` / `OutboundSink` seams usable for the GitHub Issues adapter and outbound publication
- `src/core/policy-engine.ts`
  - add eligibility and actionable-change checks
- `src/core/projection-updater.ts`
  - handle canonical ticket event types and preserve sync metadata
- `src/core/tick-runner.ts`
  - select candidates based on actionable change rather than stage alone
- `src/main.ts`
  - choose fake versus GitHub Issues source from config, resolve the static runner mode, and wire outbound publication
- `src/adapters/fs/state-store.ts`
  - persist and read GitHub poll watermark metadata
- `test/adapters/state-store.test.ts`
  - cover source-watermark persistence
- `test/core/tick-runner.test.ts`
  - cover one-shot execution for new issues and new human comments

### External docs to check while implementing

- `docs/superpowers/specs/2026-07-05-github-adapter-design.md`
- `docs/architecture.md`
- `README.md`

### Task 1: Extend config and durable state for GitHub Issues polling

**Files:**
- Modify: `package.json`
- Modify: `src/domain/schema.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/load-config.ts`
- Modify: `src/lib/paths.ts`
- Modify: `src/adapters/fs/state-store.ts`
- Test: `test/adapters/state-store.test.ts`

- [ ] **Step 1: Add the failing state-store test for poll watermark persistence**

```ts
it('writes and reads github poll state records', async () => {
  const store = createStateStore({ wakeRoot: root });

  await store.writeSourceState({
    schemaVersion: 1,
    source: 'github',
    key: 'atolis-hq/wake',
    lastSuccessfulPollAt: '2026-07-05T12:00:00.000Z',
  });

  const saved = await store.readSourceState('github', 'atolis-hq/wake');
  expect(saved?.lastSuccessfulPollAt).toBe('2026-07-05T12:00:00.000Z');
});
```

- [ ] **Step 2: Run the state-store test and verify it fails because source-state APIs do not exist**

Run: `npx vitest run test/adapters/state-store.test.ts`
Expected: FAIL with TypeScript or runtime errors mentioning `writeSourceState` / `readSourceState`.

- [ ] **Step 3: Add Octokit and extend the schemas/config shapes**

```json
{
  "dependencies": {
    "@octokit/rest": "^22.0.0",
    "zod": "^4.1.5"
  }
}
```

```ts
const githubSourceConfigSchema = z.object({
  enabled: z.boolean(),
  repos: z.array(z.string().min(1)),
  polling: z.object({
    maxIssuesPerRepo: z.number().int().positive(),
    commentPageSize: z.number().int().positive(),
    lookbackMs: z.number().int().nonnegative(),
  }),
  policy: z.object({
    requiredLabels: z.array(z.string()),
    ignoredLabels: z.array(z.string()),
  }),
  publication: z.object({
    postStatusComments: z.boolean(),
    activeLabel: z.string().optional(),
  }),
});

const sourceStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string(),
  key: z.string(),
  lastSuccessfulPollAt: isoTimestampSchema,
});
```

```ts
export type SourceStateRecord = z.infer<typeof sourceStateRecordSchema>;
```

```ts
scheduler: {
  intervalMs: 30 * 60 * 1000,
},
sources: {
  github: {
    enabled: false,
    repos: [],
    polling: {
      maxIssuesPerRepo: 25,
      commentPageSize: 25,
      lookbackMs: 60_000,
    },
    policy: {
      requiredLabels: [],
      ignoredLabels: [],
    },
    publication: {
      postStatusComments: true,
    },
  },
},
```

```ts
sources: {
  ...base.sources,
  ...(next.sources ?? {}),
  github: {
    ...base.sources.github,
    ...(next.sources?.github ?? {}),
    polling: {
      ...base.sources.github.polling,
      ...(next.sources?.github?.polling ?? {}),
    },
    policy: {
      ...base.sources.github.policy,
      ...(next.sources?.github?.policy ?? {}),
    },
    publication: {
      ...base.sources.github.publication,
      ...(next.sources?.github?.publication ?? {}),
    },
  },
},
```

- [ ] **Step 4: Add source-state persistence to the filesystem store**

```ts
async writeSourceState(record: SourceStateRecord): Promise<SourceStateRecord> {
  const parsed = parseSourceStateRecord(record);
  await writeJsonFile(paths.sourceStateFile(parsed.source, parsed.key), parsed);
  return parsed;
},

async readSourceState(source: string, key: string): Promise<SourceStateRecord | null> {
  try {
    return parseSourceStateRecord(
      await readJsonFile(paths.sourceStateFile(source, key)),
    );
  } catch {
    return null;
  }
},
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `npx vitest run test/adapters/state-store.test.ts test/domain/schema.test.ts`
Expected: PASS with the new source-state coverage and updated config parsing.

- [ ] **Step 6: Commit the config/state foundation**

```bash
git add package.json package-lock.json src/domain/schema.ts src/domain/types.ts src/config/defaults.ts src/config/load-config.ts src/adapters/fs/state-store.ts test/adapters/state-store.test.ts
git commit -m "feat: add github issues source config and state"
```

### Task 2: Add the GitHub auth bridge and Octokit client

**Files:**
- Create: `src/adapters/github/github-auth.ts`
- Create: `src/adapters/github/github-client.ts`
- Test: `test/adapters/github-auth.test.ts`

- [ ] **Step 1: Write the failing auth tests**

```ts
it('returns the gh auth token on success', async () => {
  const token = await resolveGitHubToken({
    execFile: async () => ({ stdout: 'ghs_test_token\n', stderr: '' }),
  });

  expect(token).toBe('ghs_test_token');
});

it('throws a clear error when gh auth token fails', async () => {
  await expect(
    resolveGitHubToken({
      execFile: async () => {
        throw new Error('gh not authenticated');
      },
    }),
  ).rejects.toThrow('Failed to resolve GitHub token via gh auth token');
});
```

- [ ] **Step 2: Run the auth test and verify it fails because the module does not exist**

Run: `npx vitest run test/adapters/github-auth.test.ts`
Expected: FAIL with module-not-found errors for `src/adapters/github/github-auth.ts`.

- [ ] **Step 3: Implement token resolution and a small Octokit wrapper**

```ts
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export async function resolveGitHubToken(deps?: {
  execFile?: typeof execFile;
}): Promise<string> {
  try {
    const result = await (deps?.execFile ?? execFile)('gh', ['auth', 'token']);
    const token = result.stdout.trim();
    if (token.length === 0) {
      throw new Error('empty token');
    }
    return token;
  } catch (error) {
    throw new Error(
      `Failed to resolve GitHub token via gh auth token: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
```

```ts
import { Octokit } from '@octokit/rest';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });

  return {
    async listIssues(owner: string, repo: string, perPage: number) {
      return octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: 'open',
        per_page: perPage,
      });
    },
    async listComments(owner: string, repo: string, issueNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: perPage,
      });
    },
    async createComment(owner: string, repo: string, issueNumber: number, body: string) {
      return octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
    },
  };
}
```

- [ ] **Step 4: Run the auth tests and verify they pass**

Run: `npx vitest run test/adapters/github-auth.test.ts`
Expected: PASS with one success case and one clear failure case.

- [ ] **Step 5: Commit the GitHub auth/client layer**

```bash
git add src/adapters/github/github-auth.ts src/adapters/github/github-client.ts test/adapters/github-auth.test.ts
git commit -m "feat: add github auth bridge"
```

### Task 3: Implement the GitHub Issues work source and outbound publication

**Files:**
- Create: `src/adapters/github/github-issues-work-source.ts`
- Modify: `src/core/contracts.ts`
- Modify: `src/core/projection-updater.ts`
- Test: `test/adapters/github-issues-work-source.test.ts`

- [ ] **Step 1: Write failing work-source tests for new issues, unchanged issues, and new comments**

```ts
it('emits one ticket upsert for a newly discovered eligible issue', async () => {
  const events = await workSource.pollEvents();
  expect(events.map((event) => event.sourceEventType)).toEqual(['ticket.upsert']);
});

it('does not re-emit unchanged issues on the next poll', async () => {
  await workSource.pollEvents();
  const secondPoll = await workSource.pollEvents();
  expect(secondPoll).toEqual([]);
});

it('publishes outbound comments for wake intents', async () => {
  const deliveryEvents = await workSource.deliverIntent({
    event: createEventEnvelope({
      eventId: 'intent-1',
      workItemKey: 'atolis-hq/wake#12',
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:00.000Z',
      trigger: 'context-only',
      payload: { kind: 'status-update', body: 'Handled' },
    }),
  });

  expect(deliveryEvents[0]?.sourceEventType).toBe('ticket.reply.published');
});
```

- [ ] **Step 2: Run the work-source test and verify it fails because the adapter module does not exist**

Run: `npx vitest run test/adapters/github-issues-work-source.test.ts`
Expected: FAIL with module-not-found errors for `src/adapters/github/github-issues-work-source.ts`.

- [ ] **Step 3: Implement the GitHub Issues work source and canonical event translation**

```ts
function normalizeTicketUpsert(input: {
  repo: string;
  issue: GitHubIssue;
  ingestedAt: string;
}): EventEnvelope {
  return createEventEnvelope({
    eventId: `github-issue-${input.repo}-${input.issue.number}-${input.issue.updated_at}`,
    workItemKey: `${input.repo}#${input.issue.number}`,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: input.repo,
      issueNumber: input.issue.number,
      sourceUrl: input.issue.html_url,
    },
    occurredAt: input.issue.updated_at,
    ingestedAt: input.ingestedAt,
    trigger: 'immediate',
    payload: {
      ticket: {
        repo: input.repo,
        number: input.issue.number,
        title: input.issue.title,
        body: input.issue.body ?? '',
        labels: input.issue.labels.map((label) => label.name),
        assignees: input.issue.assignees.map((assignee) => assignee.login),
        state: input.issue.state,
        url: input.issue.html_url,
        createdAt: input.issue.created_at,
        updatedAt: input.issue.updated_at,
      },
      providerEventType: 'github.issue.upsert',
    },
    raw: {
      github: {
        issueUpdatedAt: input.issue.updated_at,
      },
    },
  });
}
```

```ts
export function createGitHubIssuesWorkSource(deps: {
  client: ReturnType<typeof createGitHubClient>;
  stateStore: ReturnType<typeof import('../fs/state-store.js').createStateStore>;
  config: WakeConfig;
  now: () => Date;
}) {
  return {
    async pollEvents(): Promise<EventEnvelope[]> {
      const ingestedAt = deps.now().toISOString();
      const events: EventEnvelope[] = [];

      for (const repoRef of deps.config.sources.github.repos) {
        const [owner, repo] = repoRef.split('/');
        const issues = await deps.client.listIssues(
          owner!,
          repo!,
          deps.config.sources.github.polling.maxIssuesPerRepo,
        );

        for (const issue of issues) {
          const local = await deps.stateStore.readIssueState(repoRef, issue.number);
          if (local?.issue.updatedAt !== issue.updated_at) {
            events.push(normalizeTicketUpsert({ repo: repoRef, issue, ingestedAt }));
          }

          const comments = await deps.client.listComments(
            owner!,
            repo!,
            issue.number,
            deps.config.sources.github.polling.commentPageSize,
          );

          for (const comment of comments) {
            const known = local?.comments.find((entry) => entry.id === String(comment.id));
            if (known?.updatedAt === comment.updated_at) {
              continue;
            }

            events.push(normalizeTicketCommentEvent({
              repo: repoRef,
              issueNumber: issue.number,
              comment,
              ingestedAt,
            }));
          }
        }

        await deps.stateStore.writeSourceState({
          schemaVersion: 1,
          source: 'github',
          key: repoRef,
          lastSuccessfulPollAt: ingestedAt,
        });
      }

      return events;
    },
    async deliverIntent(input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
      const repo = input.event.sourceRefs.repo!;
      const issueNumber = input.event.sourceRefs.issueNumber!;
      const [owner, repoName] = repo.split('/');

      await deps.client.createComment(
        owner!,
        repoName!,
        issueNumber,
        `${String(input.event.payload.body)}\n\n<!-- wake -->`,
      );

      return [createEventEnvelope({
        eventId: `${input.event.eventId}-published`,
        workItemKey: input.event.workItemKey,
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'github',
        sourceEventType: 'ticket.reply.published',
        sourceRefs: {
          repo,
          issueNumber,
        },
        occurredAt: deps.now().toISOString(),
        ingestedAt: deps.now().toISOString(),
        trigger: 'context-only',
        payload: {
          intentEventId: input.event.eventId,
          kind: input.event.payload.kind,
          body: input.event.payload.body,
          providerEventType: 'github.issue.comment.published',
        },
      })];
    },
  };
}
```

- [ ] **Step 4: Teach the projection updater about canonical ticket event types only**

```ts
if (event.sourceEventType === 'fake.issue.upsert' || event.sourceEventType === 'ticket.upsert') {
  const ticket = event.payload.ticket;
  // map canonical ticket payloads into IssueStateRecord.issue
}

if (
  event.sourceEventType === 'fake.issue.comment.created' ||
  event.sourceEventType === 'ticket.comment.created' ||
  event.sourceEventType === 'ticket.comment.updated'
) {
  const comment = event.payload.comment;
  // map canonical comment payloads into IssueStateRecord.comments, with replace-on-update for matching comment ids
}
```

- [ ] **Step 5: Run the adapter tests and verify they pass**

Run: `npx vitest run test/adapters/github-auth.test.ts test/adapters/github-issues-work-source.test.ts test/core/projection-updater.test.ts`
Expected: PASS with canonical-event translation coverage and outbound publication coverage.

- [ ] **Step 6: Commit the GitHub Issues adapter**

```bash
git add src/adapters/github/github-issues-work-source.ts src/core/contracts.ts src/core/projection-updater.ts test/adapters/github-issues-work-source.test.ts
git commit -m "feat: add github issues work source"
```

### Task 4: Make policy and tick execution act on new or changed ticket work

**Files:**
- Modify: `src/core/policy-engine.ts`
- Modify: `src/core/tick-runner.ts`
- Modify: `src/main.ts`
- Test: `test/core/tick-runner.test.ts`

- [ ] **Step 1: Write a failing tick-runner test for one-shot execution on a new human comment**

```ts
it('runs once when a new human comment arrives on an eligible issue', async () => {
  let callCount = 0;
  const runner = {
    async run() {
      callCount += 1;
      return { result: 'Handled\nDONE', session_id: 'session-2' };
    },
  };

  await tickRunner.runTick();
  await tickRunner.runTick();

  expect(callCount).toBe(1);
});
```

- [ ] **Step 2: Run the tick-runner test and verify it fails because candidate selection is stage-only**

Run: `npx vitest run test/core/tick-runner.test.ts`
Expected: FAIL with repeated runner invocation on unchanged ticket items.

- [ ] **Step 3: Extend policy to separate eligibility from actionable change**

```ts
export function createPolicyEngine() {
  return {
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      const labels = new Set(issue.issue.labels);
      if (issue.issue.state !== 'open') {
        return false;
      }
      if (config.sources.github.policy.requiredLabels.some((label) => !labels.has(label))) {
        return false;
      }
      if (config.sources.github.policy.ignoredLabels.some((label) => labels.has(label))) {
        return false;
      }
      return true;
    },
    needsWakeAction(issue: IssueStateRecord): boolean {
      const latest = issue.latestComment;
      const context = issue.context as Record<string, unknown>;
      const lastActionEventId = typeof context.lastWakeActionEventId === 'string'
        ? context.lastWakeActionEventId
        : undefined;

      if (issue.wake.lastRunId === undefined) {
        return true;
      }

      return latest !== undefined && !latest.isWakeAuthored && latest.id !== lastActionEventId;
    },
    chooseAction(stage: Stage): AgentAction | null {
      if (stage === 'queue') return 'refine';
      if (stage === 'refined') return 'implement';
      return null;
    },
  };
}
```

- [ ] **Step 4: Wire the real source in `src/main.ts` and use the new policy path in the tick runner**

```ts
const githubEnabled = config.sources.github.enabled;
const workSource = githubEnabled
  ? createGitHubIssuesWorkSource({
      client: createGitHubClient(await resolveGitHubToken()),
      stateStore,
      config,
      now: () => systemClock.now(),
    })
  : await createFileBackedFakeTicketingSystem({
      fixturePath: stateStore.paths.issueFixtureFile,
      now: () => systemClock.now(),
    });
```

```ts
const candidate = projections.find((issue) => {
  if (!policy.isEligible(issue, deps.config)) {
    return false;
  }

  const nextAction = policy.chooseAction(issue.wake.stage);
  return nextAction !== null && policy.needsWakeAction(issue);
});
```

- [ ] **Step 5: Run the tick and CLI tests**

Run: `npx vitest run test/core/tick-runner.test.ts test/cli/control-plane.test.ts`
Expected: PASS with no repeat execution on unchanged ticket-backed issues.

- [ ] **Step 6: Commit the policy/tick wiring**

```bash
git add src/core/policy-engine.ts src/core/tick-runner.ts src/main.ts test/core/tick-runner.test.ts
git commit -m "feat: trigger wake runs from ticket changes"
```

### Task 5: Finish docs and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Test: `test/adapters/github-auth.test.ts`
- Test: `test/adapters/github-issues-work-source.test.ts`
- Test: `test/adapters/state-store.test.ts`
- Test: `test/core/tick-runner.test.ts`

- [ ] **Step 1: Document GitHub configuration and runtime behavior**

```md
## GitHub Issues polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake uses a fixed runner mode of either `fake` or
`claude`.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those
events, rebuilds local projections, decides whether work is needed, and only
then invokes Eddy.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm test`
Expected: PASS with all existing tests plus the new GitHub adapter coverage.

Run: `npm run build`
Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Review the working tree and ensure only intended files changed**

Run: `git status --short`
Expected: only GitHub adapter, config, test, and documentation files are modified.

- [ ] **Step 4: Commit the documentation and verification pass**

```bash
git add README.md docs/architecture.md
git commit -m "docs: describe github polling adapter"
```

## Self-Review

### Spec coverage

- GitHub Issues source config, polling interval, and label policy are covered in Task 1 and Task 4.
- `gh auth token` plus Octokit transport is covered in Task 2.
- thin GitHub Issues adapter translation and local sync are covered in Task 3.
- tick-owned sync and Wake-owned action policy are covered in Task 4.
- minimal outbound GitHub publication and fixed runner-mode support are covered in Task 3 and Task 4.
- docs and acceptance verification are covered in Task 5.

### Placeholder scan

- No placeholder markers remain.
- Each task names exact files, commands, and expected outcomes.
- Code-changing steps include concrete code blocks rather than abstract instructions.

### Type consistency

- The plan uses `sources.github` consistently across config work.
- Source watermark persistence uses `SourceStateRecord`, `writeSourceState`, and `readSourceState` consistently.
- The runtime path consistently uses `createGitHubIssuesWorkSource`, `resolveGitHubToken`, and `createGitHubClient`.

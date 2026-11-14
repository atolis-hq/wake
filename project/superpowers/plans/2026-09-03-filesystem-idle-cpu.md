# Filesystem Idle CPU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated filesystem scans from idle subscription cycles and recursive ownership mutation from every sandbox start.

**Architecture:** `FileEventJournal` will memoize a validated segment fingerprint for a bounded 30-second interval, share an in-flight refresh, and invalidate it on journal notifications. Generated and repository Docker entrypoints will create/chown only the `.wake` directory itself instead of traversing its contents.

**Tech Stack:** TypeScript, Node.js filesystem APIs and watchers, Vitest, Dockerfile shell entrypoints.

---

### Task 1: Share filesystem journal validation

**Files:**
- Modify: `packages/eventing-filesystem/src/file-event-journal.ts`
- Test: `packages/eventing-filesystem/test/file-event-journal.test.ts`
- Modify: `packages/eventing-filesystem/SPEC.md`

- [ ] **Step 1: Write failing concurrent-validation tests**

Add adapter seams for a clock and entry reader to `FileEventJournalOptions`, then construct a journal whose entry reader is deferred and counted. Start concurrent `latestGlobalPosition()`, `readAll()`, and `readStream()` calls and assert they request one entry refresh rather than one refresh per caller. Add a second case where the first entry refresh rejects and the next read retries successfully.

- [ ] **Step 2: Verify the tests fail for duplicate refreshes**

Run:

```bash
npx vitest run --config packages/eventing-filesystem/vitest.config.ts packages/eventing-filesystem/test/file-event-journal.test.ts -t "shares one journal fingerprint refresh|retries a failed fingerprint refresh"
```

Expected: the concurrent case observes multiple refresh calls because `readEntriesForRead()` is currently uncached.

- [ ] **Step 3: Implement bounded shared validation**

Add private state equivalent to:

```ts
private validatedEntries:
  | { readonly entries: readonly FileStat[]; readonly expiresAt: number }
  | undefined;
private inFlightEntries: Promise<readonly FileStat[]> | undefined;
```

`readEntriesForRead()` must return the unexpired value, reuse `inFlightEntries`, or start one `readCurrentEntries()` call. Store successful results for 30 seconds and clear the in-flight promise in `finally`; never cache a rejection. Route watcher notifications through a method that clears `validatedEntries` before notifying subscribers. After a local append extends the journal cache, update or invalidate the validation state consistently so the appended head is immediately visible.

- [ ] **Step 4: Add invalidation and expiry tests**

Using fake timers and `controlledWatcherFactory`, prove that repeated reads inside 30 seconds reuse validation, `watcher.notify()` forces the next read to discover an external append, and an external append is discovered after 30 seconds when watcher setup fails.

- [ ] **Step 5: Run package verification**

Run:

```bash
npm test --workspace @atolis-hq/eventing-filesystem
npm run build --workspace @atolis-hq/eventing-filesystem
```

Expected: all filesystem package tests and typechecking pass.

- [ ] **Step 6: Document and commit**

Update `packages/eventing-filesystem/SPEC.md` to state that fingerprint validation is shared, notification-invalidated, and bounded by a hard refresh. Commit:

```bash
git add packages/eventing-filesystem/src/file-event-journal.ts packages/eventing-filesystem/test/file-event-journal.test.ts packages/eventing-filesystem/SPEC.md
git commit -m "fix: share journal filesystem validation"
```

### Task 2: Remove recursive sandbox startup ownership scan

**Files:**
- Modify: `docker/Dockerfile`
- Modify: `docker/Dockerfile.packaged`
- Modify: `src/bootstrap/initialise.ts`
- Test: `test/integration/bootstrap/initialise.test.ts`

- [ ] **Step 1: Change generation tests first**

Replace assertions expecting `chown -R wake:wake /wake/.wake` with assertions requiring `chown wake:wake /wake/.wake` and explicitly rejecting the recursive form in source, packaged, scaffolded, and repository Dockerfiles.

- [ ] **Step 2: Verify the tests fail on recursive ownership**

Run:

```bash
npx vitest run --config vitest.integration.config.ts test/integration/bootstrap/initialise.test.ts
```

Expected: Dockerfile assertions fail because all entrypoints still contain `chown -R`.

- [ ] **Step 3: Change only the entrypoint ownership operation**

In both repository Dockerfiles and both generated Dockerfile templates, retain:

```sh
mkdir -p /wake/.wake
chown wake:wake /wake/.wake || true
```

Remove only the recursive `-R`. Preserve home-directory initialization and the existing switch to the `wake` user.

- [ ] **Step 4: Verify sandbox tests and current documentation**

Run:

```bash
npx vitest run --config vitest.integration.config.ts test/integration/bootstrap/initialise.test.ts test/integration/surfaces/cli-infrastructure.test.ts
npm run check:specs:report
```

Expected: integration tests pass; any unrelated pre-existing specification drift remains informational.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile docker/Dockerfile.packaged src/bootstrap/initialise.ts test/integration/bootstrap/initialise.test.ts
git commit -m "fix: avoid recursive sandbox startup ownership"
```

### Task 3: Merge gate and PR update

**Files:**
- Verify only.

- [ ] **Step 1: Run focused runtime scenarios**

```bash
npx vitest run --config vitest.e2e.config.ts test/e2e/scenarios/run-starting-visibility.test.ts test/e2e/scenarios/tick-resident-equivalence.test.ts
```

Expected: all selected scenarios pass.

- [ ] **Step 2: Run the repository verification gate**

```bash
npm run verify
```

Expected: catalogue, scenarios, architecture, lint, formatting, source resolution, build, package tests, and Wake unit tests pass.

- [ ] **Step 3: Review the final diff**

Confirm that the event representation and public Eventing contracts remain unchanged, no scheduler interval changed, no retention behavior was introduced, and unrelated untracked review files remain untouched.

- [ ] **Step 4: Push and monitor PR checks**

```bash
git push origin feat/event-driven-runtime
gh pr checks 790 --watch --interval 10
```

Expected: all required PR checks pass at the pushed HEAD.

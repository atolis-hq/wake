# Conversation Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a WorkItem's discussion a durable provider-neutral Conversation, consume it for agent context, and present it in the control-plane UI.

**Architecture:** `conversations` owns conversation event streams and projections. Integrations submit validated provider-neutral entry commands after recording their evidence; agent context and surfaces consume the projection. Delivery remains adapter-owned.

**Tech Stack:** TypeScript, Zod, Vitest, event journal/projections, React API client.

---

### Task 1: Conversation module

**Files:** Create `src/conversations/{MODULE.md,module.json,index.ts,contracts/{identifiers,streams,events,commands,views}.ts,domain/conversation.ts,application/{conversation-service,conversation-repository,conversation-projection}.ts}`; modify `src/bootstrap/{composition-root,projection-runtime}.ts`; test `test/unit/conversations/*.test.ts`.

- [ ] Write failing tests for creation with a WorkItem, idempotent external source entries, ordered entries, resource links, revision, and tombstone.
- [ ] Implement typed `conversation.*` events, selectors/decoders, folds, repository, service, and projection registration.
- [ ] Run focused conversation tests and commit.

### Task 2: GitHub conversation ingestion and context

**Files:** Modify `src/integrations/github/{application/inbound-translator.ts,application/agent-context-reader.ts,provider.ts,index.ts}`, `src/integrations/contracts/provider.ts`, `src/bootstrap/{composition-root,integration-runtime}.ts`; test relevant GitHub unit tests and E2E context scenario.

- [ ] Write failing tests proving a GitHub comment produces exactly one Conversation entry and the context reader uses conversation entries.
- [ ] Add a provider-neutral conversation-entry port to provider services; submit the command only after GitHub evidence is validated; replace the GitHub history dependency in the context reader.
- [ ] Run focused GitHub/context tests and commit.

### Task 3: Agent output and delivery correlation

**Files:** Modify `src/integrations/application/agent-run-publication-reactor.ts`, delivery intents/events and GitHub reconciliation reader; test agent-publication/comment-history integration.

- [ ] Write failing tests for one Wake/agent-originated entry with delivery representation attached on confirmation/observed echo.
- [ ] Record agent-facing output as an agent-origin Conversation entry before optional publication; make intent/confirmation carry Conversation entry correlation without putting target policy in Conversations.
- [ ] Run focused delivery tests and commit.

### Task 4: Conversation API and timeline

**Files:** Modify `src/surfaces/api/{contracts, routes, presenters,applications}.ts`, `src/bootstrap/surface-api-*.ts`, `src/surfaces/web/src/{api,features/work}`; tests in API/web suites.

- [ ] Write failing API and web tests for WorkItem conversation timeline source, actor, stage/run, timestamps, and resource/transcript links.
- [ ] Add a read-only work-scoped conversation endpoint and client decoder/query; render the timeline in Work detail.
- [ ] Run focused API/web tests and commit.

### Task 5: Control-plane message and stage reaction

**Files:** Modify surface command route/application, Conversation service, reaction bridge/bootstrap composition; tests for control-plane entry triggering current-stage agent action and no-op when no agent activity exists.

- [ ] Write failing state-specific reaction tests.
- [ ] Add the authenticated control-plane command; record an attributed entry, call the existing reply-rule bridge, and do not publish externally without configured adapter rules.
- [ ] Run focused tests and commit.

### Task 6: Docs and full verification

**Files:** Modify module manifests/specs and current API/UI reference docs as required.

- [ ] Update module manifests and reference documentation.
- [ ] Run `npm run verify`, relevant E2E and web tests, `npm run check:catalogue`, `npm run check:scenarios`, `npm run check:specs`, and `npm run lint:architecture`.
- [ ] Review diff, commit, push branch, create PR that references #691 and the design spec.

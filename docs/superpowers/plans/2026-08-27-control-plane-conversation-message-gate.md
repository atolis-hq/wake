# Control-plane Conversation Message Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make control-plane conversation messages an explicit, default-off API capability while keeping conversation timeline reads available.

**Architecture:** `surfaces` owns the strict `surfaces.api.conversationMessages.enabled` configuration setting. Bootstrap reads that resolved setting when it composes the work API applications: disabled omits the optional `message` capability, allowing the existing command route to return `command-unavailable`; enabled retains the current record-and-resume operation unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, YAML configuration, Markdown documentation.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/surfaces/contracts/config.ts` | Validate and resolve the new default-off surface configuration. |
| `src/bootstrap/surface-api-work-applications.ts` | Conditionally expose the optional message API application capability. |
| `test/unit/bootstrap/root-schema.test.ts` | Prove omitted and explicit configuration values resolve correctly. |
| `test/unit/bootstrap/surface-api-work-applications.test.ts` | Prove the default cannot expose message creation and explicit enablement retains it. |
| `docs/configuration.md` | Document the field and show it in the complete Wake-home configuration example. |
| `src/bootstrap/initialise.ts` | Keep the generated Wake-home configuration explicit about the safe default. |

### Task 1: Define and verify the resolved configuration

**Files:**
- Modify: `test/unit/bootstrap/root-schema.test.ts`
- Modify: `src/surfaces/contracts/config.ts`

- [ ] **Step 1: Write the failing configuration tests**

Add assertions to the existing surface-configuration tests:

```ts
it('disables control-plane conversation messages unless explicitly enabled', () => {
  expect(parseRootConfig(baseConfig).surfaces.api.conversationMessages.enabled).toBe(false);
  expect(
    parseRootConfig({
      ...baseConfig,
      surfaces: { api: { conversationMessages: { enabled: true } } },
    }).surfaces.api.conversationMessages.enabled,
  ).toBe(true);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/unit/bootstrap/root-schema.test.ts`

Expected: FAIL because `conversationMessages` is absent from the resolved API configuration.

- [ ] **Step 3: Add the minimal strict schema and resolved default**

Extend the `api` schema in `src/surfaces/contracts/config.ts` and its defaults/transform:

```ts
conversationMessages: z
  .object({ enabled: z.boolean().default(false) })
  .strict()
  .default({ enabled: false }),
```

Ensure the resolved API value is exactly:

```ts
conversationMessages: { enabled: value.api.conversationMessages.enabled ?? false },
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/unit/bootstrap/root-schema.test.ts`

Expected: PASS.

### Task 2: Gate the write capability at composition

**Files:**
- Modify: `test/unit/bootstrap/surface-api-work-applications.test.ts`
- Modify: `src/bootstrap/surface-api-work-applications.ts`

- [ ] **Step 1: Write the failing capability tests**

Add a default-off test using a minimal root configuration:

```ts
it('does not expose control-plane message creation when disabled', () => {
  const applications = createSurfaceWorkApplications(
    { config: { surfaces: { api: { conversationMessages: { enabled: false } } } } } as CompositionRoot,
    () => '2026-08-27T00:00:00.000Z',
  );

  expect(applications.message).toBeUndefined();
});
```

Also update the existing message tests' roots to set `enabled: true`, so they prove the operation remains available only after opt-in.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/unit/bootstrap/surface-api-work-applications.test.ts`

Expected: FAIL because the message capability is still always present.

- [ ] **Step 3: Conditionally add the existing message operation**

Extract the current `async message(...)` implementation into a local `message` value. Return it only when `root.config.surfaces.api.conversationMessages.enabled` is true:

```ts
return {
  // existing read and operator command capabilities
  ...(root.config.surfaces.api.conversationMessages.enabled === true ? { message } : {}),
};
```

Do not alter entry recording, actor attribution, or the resume bridge; this task only controls reachability.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/unit/bootstrap/surface-api-work-applications.test.ts`

Expected: PASS.

### Task 3: Document the opt-in and verify the surface contract

**Files:**
- Modify: `src/bootstrap/initialise.ts`
- Modify: `docs/configuration.md`
- Test: `test/integration/surfaces/api-routes.test.ts`

- [ ] **Step 1: Write the failing API-route assertion**

In the work-item command route coverage, compose applications with the setting omitted and send `POST /api/v1/work-items/<key>/commands/message`. Assert the existing unavailable response:

```ts
expect(response.status).toBe(409);
expect(response.body).toMatchObject({ code: 'command-unavailable' });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/integration/surfaces/api-routes.test.ts -t "message"`

Expected: FAIL because the command is currently accepted when the configuration is omitted.

- [ ] **Step 3: Update current-state documentation and scaffold**

Change the generated `surfaces` section in `src/bootstrap/initialise.ts` to include:

```yaml
surfaces:
  api:
    conversationMessages:
      # Disabled until Wake can attribute messages to the authenticated operator.
      enabled: false
```

Add the same value to the complete `docs/configuration.md` example and add a table row:

```markdown
| `surfaces.api.conversationMessages.enabled` | boolean; default `false` | Enables control-plane-created conversation messages and their workflow-resume bridge. Leave disabled until operator identity is available to Wake; conversation timeline reads remain available. |
```

- [ ] **Step 4: Run the focused integration test to verify it passes**

Run: `npx vitest run test/integration/surfaces/api-routes.test.ts -t "message"`

Expected: PASS.

### Task 4: Validate and commit

**Files:**
- Modify: files from Tasks 1–3

- [ ] **Step 1: Run targeted verification**

Run:

```bash
npx vitest run test/unit/bootstrap/root-schema.test.ts test/unit/bootstrap/surface-api-work-applications.test.ts test/integration/surfaces/api-routes.test.ts
npm run format:check
```

Expected: PASS.

- [ ] **Step 2: Run cross-cutting verification**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 3: Commit the completed feature**

```bash
git add src/surfaces/contracts/config.ts src/bootstrap/surface-api-work-applications.ts src/bootstrap/initialise.ts test/unit/bootstrap/root-schema.test.ts test/unit/bootstrap/surface-api-work-applications.test.ts test/integration/surfaces/api-routes.test.ts docs/configuration.md docs/superpowers/plans/2026-08-27-control-plane-conversation-message-gate.md
git commit -m "feat: gate control-plane conversation messages"
```

## Self-review

- Spec coverage: Tasks 1–2 implement the default-off setting and the conditional write/resume capability; Task 3 preserves read access and documents the opt-in; Task 4 verifies the complete change.
- Placeholder scan: no TBD, TODO, or undefined implementation steps remain.
- Type consistency: the configuration property is consistently `surfaces.api.conversationMessages.enabled`; `message` remains the existing optional `ApiApplications['work']` capability.

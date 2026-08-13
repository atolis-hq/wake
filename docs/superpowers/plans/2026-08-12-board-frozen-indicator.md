# Board Frozen Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a cold-blue frozen badge on every frozen work item card on the board.

**Architecture:** Carry the durable `frozen` flag from the work-item projection into the board-card API DTO and decode it in the web client. `BoardCard` owns rendering the accessible snowflake badge using the existing status-badge visual primitive.

**Tech Stack:** TypeScript, React, Vitest, Testing Library.

---

### Task 1: Expose frozen state in board data

**Files:**
- Modify: `src/bootstrap/board-projection.ts`
- Modify: `src/surfaces/api/contracts/board.ts`
- Modify: `src/surfaces/web/src/api/decoders.ts`
- Test: `test/unit/bootstrap/board-projection.test.ts`

- [ ] **Step 1: Write the failing projection test**

Add a `WorkEventType.ItemFrozen` event after an item creation in the existing
board-projection fixture and assert:

```ts
expect(view.cards[workItemId]).toMatchObject({ frozen: true });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/bootstrap/board-projection.test.ts`

Expected: failure because `frozen` is not present on the projected board card.

- [ ] **Step 3: Implement the minimal data propagation**

Add optional `frozen?: boolean` to `BoardCardResponse`, copy the work-item
freeze flag into the board projection's stored card when handling the frozen
and unfrozen work events, and decode it in `decodeBoardCard` with:

```ts
...optionalBooleanProperty(record, 'frozen', path),
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/unit/bootstrap/board-projection.test.ts`

Expected: PASS.

### Task 2: Render the cold-blue frozen badge

**Files:**
- Modify: `src/surfaces/web/src/features/board/board-card.tsx`
- Modify: `src/surfaces/web/src/components/primitives.tsx`
- Modify: `src/surfaces/web/src/components/components.module.css`
- Test: `src/surfaces/web/test/board.test.tsx`

- [ ] **Step 1: Write the failing board render test**

Give one board fixture `frozen: true`. Assert its card exposes a `frozen` badge
with title `Automatic progress is paused while this work item is frozen`; assert
the non-frozen fixture has no such text.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:web -- board.test.tsx`

Expected: failure because the frozen metadata is not rendered.

- [ ] **Step 3: Implement the minimal indicator**

Add a decorative `FrozenIcon` SVG to `board-card.tsx`, then render:

```tsx
{item.frozen === true && (
  <StatusBadge tone="cold" title="Automatic progress is paused while this work item is frozen">
    <FrozenIcon />
    frozen
  </StatusBadge>
)}
```

Add a `cold` tone to the shared `StatusBadge`, styled in
`components.module.css` with a cold-blue foreground, border, and translucent
background. Do not change cards that do not have `frozen: true`.

- [ ] **Step 4: Run the focused UI test to verify it passes**

Run: `npm run test:web -- board.test.tsx`

Expected: PASS.

### Task 3: Verify the integrated change

**Files:**
- Verify: `src/bootstrap/board-projection.ts`
- Verify: `src/surfaces/api/contracts/board.ts`
- Verify: `src/surfaces/web/src/api/decoders.ts`
- Verify: `src/surfaces/web/src/features/board/board-card.tsx`
- Verify: `src/surfaces/web/test/board.test.tsx`

- [ ] **Step 1: Run the complete web test suite**

Run: `npm run test:web`

Expected: PASS with no test failures.

- [ ] **Step 2: Build the web package**

Run: `npm run build:web`

Expected: exit code 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff --check HEAD~1..HEAD`

Expected: no whitespace errors; the diff is limited to the frozen-state data
path, the badge, focused tests, and these approved design records.

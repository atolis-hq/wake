# Event Panel and Full-Width Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render legacy-equivalent expandable event cards and make every target web route use the full available page width while preserving responsive gutters.

**Architecture:** `EventRow` remains shared by the events page and work-item detail tabs. The shared application-shell CSS controls route width, while feature CSS controls event-card layout.

**Tech Stack:** React 19, TypeScript, CSS modules, Vitest, Testing Library, Vite.

---

## File structure

- Modify: `src-next/surfaces/web/src/components/components.module.css` — remove the shared width cap.
- Modify: `src-next/surfaces/web/src/features/events/events.tsx` — card summary, chevron, complete JSON body.
- Modify: `src-next/surfaces/web/src/features/features.module.css` — responsive event-card layout.
- Modify: `src-next/surfaces/web/test/events.test.tsx` — event-row DOM behavior.

### Task 1: Write the failing event-card test

**Files:**
- Modify: `src-next/surfaces/web/test/events.test.tsx`

- [ ] **Step 1: Replace the event-row test with one whose record has type `work.item.transitioned.from.intake.to.implementation`, `correlationId: 'correlation-1'`, and nested payload.** Assert its button starts with `aria-expanded="false"`, the complete type is visible, and the collapsed chevron `›` is visible. Click it, then assert `aria-expanded="true"`, expanded chevron `⌄`, `"correlationId": "correlation-1"`, and nested payload JSON are visible.

- [ ] **Step 2: Run `npx vitest run src-next/surfaces/web/test/events.test.tsx`.** Expect failure because the current row has no chevron and serializes only `payload`.

### Task 2: Implement and validate the event card

**Files:**
- Modify: `src-next/surfaces/web/src/features/events/events.tsx:80-99`
- Modify: `src-next/surfaces/web/src/features/features.module.css:145-181,341-354`
- Test: `src-next/surfaces/web/test/events.test.tsx`

- [ ] **Step 1: In `EventRow`, retain the existing state and click handler. Add `styles.eventChevron` with `aria-hidden="true"` and text `{expanded ? '⌄' : '›'}` after the ID. Replace the current `pre` with an `eventPayload` wrapper containing `JSON.stringify(record, null, 2)` so every API response field is displayed.**

- [ ] **Step 2: Change `.event` into an overflow-hidden card. Change `.eventButton` to a four-column grid: `minmax(11rem, 14rem) minmax(0, 1fr) minmax(8rem, 18rem) 2.4rem`. Let `.eventType` wrap (`white-space: normal`) without ellipsis. Right-align `.eventChevron`. Give `.eventPayload` a top border and horizontal scrolling; give its `pre` margin `0`, normal padding, and `white-space: pre`. In the mobile rule, hide only `.eventId` and use timestamp/type/chevron columns.**

- [ ] **Step 3: Run `npx vitest run src-next/surfaces/web/test/events.test.tsx`.** Expect PASS.

- [ ] **Step 4: Commit with `git add src-next/surfaces/web/src/features/events/events.tsx src-next/surfaces/web/src/features/features.module.css src-next/surfaces/web/test/events.test.tsx` followed by `git commit -m "fix(web): restore expandable event cards"`.**

### Task 3: Remove the shared page-width cap

**Files:**
- Modify: `src-next/surfaces/web/src/components/components.module.css:70-74,241-244`

- [ ] **Step 1: Set desktop `.main` to `width: 100%; margin: 0; padding: var(--space-6) var(--space-4);`. In the existing `42rem` media query, retain `width: 100%` and use `padding: var(--space-4) var(--space-2) 0;`. This removes both maximum widths while preserving 1rem desktop and 0.5rem mobile gutters.**

- [ ] **Step 2: Run `npm run build:web`.** Expect PASS.

- [ ] **Step 3: Commit with `git add src-next/surfaces/web/src/components/components.module.css` followed by `git commit -m "fix(web): use full-width page layout"`.**

### Task 4: Verify the completed surface

**Files:**
- Verify: `src-next/surfaces/web/test/events.test.tsx`
- Verify: `src-next/surfaces/web/src/components/components.module.css`

- [ ] **Step 1: Run `npm run test:web`.** Expect PASS.

- [ ] **Step 2: Run `npm run lint:contracts`, `npm run lint:architecture`, `npm run knip:next`, and `npm run verify:next`.** Expect every command to exit successfully.

- [ ] **Step 3: Run `npm run verify`.** Expect PASS.

- [ ] **Step 4: Run `git diff --check` and `git status --short`.** Expect no whitespace errors and no unintended changes in this task's files.

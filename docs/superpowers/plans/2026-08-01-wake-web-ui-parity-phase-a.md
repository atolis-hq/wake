# Wake Web UI Parity — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `src-next` web surface to the legacy Wake control-plane look — dark, dense, teal — using only the data today's `/api/v1` already returns.

**Architecture:** A two-layer CSS custom-property system (raw palette → semantic tokens) replaces the current light-theme token file. Components reference semantic tokens only, so a light theme later is one assignment block. Feature and component styles stay in CSS Modules; no CSS framework, component library, chart library, or icon library is added. No API, bootstrap, or domain file is touched.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, Vite 8, Vitest 4 + Testing Library, Playwright 1.58 + axe-core. Workspace `@atolis-hq/wake-web` at `src-next/surfaces/web`.

## Global Constraints

- **Scope is UI-only.** Modify nothing outside `src-next/surfaces/web/`. No file under `src-next/surfaces/api/`, `src-next/bootstrap/`, or any domain module.
- **No new runtime dependencies.** No CSS, component, table, chart, icon, or state-management framework. `package.json` dependencies do not change.
- **Dark theme only**, but every colour a component uses must be a semantic token, never a literal. Adding light later must require no component edits.
- **The browser stays generic.** No component branches on a resource `kind`, a provider, or an activity type. Resources are opaque references.
- **No control that cannot work.** Do not add buttons for routes that return 501 (freeze, unfreeze, delete, retry, pause, resume).
- **TypeScript is strict** with `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` (root `tsconfig.json`). Consequences you will hit constantly:
  - CSS Module members are `string | undefined`, so every `styles.foo` used where a `string` is required needs `styles.foo!` — as `app-shell.tsx:25` already does.
  - Optional props must be spread conditionally (`...(x === undefined ? {} : { x })`), never passed as `x={undefined}`.
- **Commands** (run from the repository root):
  - Unit tests: `npm run test --workspace @atolis-hq/wake-web`
  - Single unit file: `npm run test --workspace @atolis-hq/wake-web -- test/<file>`
  - Typecheck + build: `npm run build --workspace @atolis-hq/wake-web`
  - E2E (builds assets and starts the fixture itself): `npm run test:e2e --workspace @atolis-hq/wake-web`
- **Do not weaken existing tests.** `test/*.test.tsx` and `e2e/operator-journey.spec.ts` must keep passing unchanged, except where a task explicitly edits them.
- **Formatting:** write files with `npx prettier --write --end-of-line lf <file>` before committing.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/styles/palette.css` | Layer 1. Raw colour values only. Referenced solely by `tokens.css`. |
| `src/components/chip.tsx` | `Chip` — the dense label primitive legacy uses on cards. |
| `src/components/tile.tsx` | `Tile` — the big-number stat block used by Observability. |
| `src/features/board/board-card.tsx` | Board card presentation, isolated from board layout. Lives in the feature, not `components/`, per web surface design §8.1: a component stays inside its feature until a second feature needs it. |
| `test/tokens.test.ts` | Token contract: semantic names exist, no literals leak, contrast meets AA. |
| `test/board.test.tsx` | Board columns, counts, empty columns, collapse persistence. |
| `test/work-detail.test.tsx` | Structured sections, generic resources, no activity-specific section. |
| `test/runs.test.tsx` | Structured transcript rendering. |

**Modified:**

| File | Change |
| --- | --- |
| `src/styles/tokens.css` | Becomes layer 2: semantic tokens assigned from the palette. |
| `src/styles/global.css` | Dark base, tokenised focus ring, monospace family. |
| `src/components/components.module.css` | Three-band shell, dark panels, tables, chips, pills, tiles. |
| `src/components/app-shell.tsx` | Three-band chrome; status band wraps `ControlPlaneStatus`. |
| `src/components/primitives.tsx` | `StatusBadge` gains condition tones. |
| `src/features/features.module.css` | Board, card, detail, event, and metric styles. |
| `src/features/board/board.tsx` | Column counts, empty columns, collapse; delegates cards. |
| `src/features/work/work.tsx` | Structured detail sections; generic resources. |
| `src/features/events/events.tsx` | Event card markup. |
| `src/features/runs/runs.tsx` | Structured transcript. |
| `src/features/observability/observability.tsx` | Tiles. |
| `e2e/surface-fixture.ts` | Representative dataset (Task 4). |

---

### Task 1: Two-layer dark token system

**Files:**

- Create: `src-next/surfaces/web/src/styles/palette.css`
- Modify: `src-next/surfaces/web/src/styles/tokens.css`
- Test: `src-next/surfaces/web/test/tokens.test.ts`

**Interfaces:**

- Produces: the semantic custom-property names every later task uses —
  `--surface`, `--surface-panel`, `--surface-card`, `--surface-inset`,
  `--border`, `--border-strong`, `--ink`, `--ink-muted`, `--ink-inverse`,
  `--brand`, `--brand-dark`, `--brand-darker`, `--nav-ink-idle`,
  `--accent`, `--accent-light`, `--good`, `--warning`, `--bad`,
  `--cond-{ready,scheduled,active,needs-human,error,finished}-{fg,bg}`,
  `--space-{2,3,4,5,6}`, `--radius`, `--radius-sm`, `--shadow`,
  `--focus-ring`, `--font-sans`, `--font-mono`,
  `--text-{xs,sm,base,lg}`, `--content-width`, `--motion-fast`.

- [ ] **Step 1: Write the failing token contract test**

Create `src-next/surfaces/web/test/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const palette = read('../src/styles/palette.css');
const tokens = read('../src/styles/tokens.css');

function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    found.set(match[1]!, match[2]!.trim());
  return found;
}

/** Resolves `var(--x)` against the palette so semantic tokens yield literal colours. */
function resolve(name: string): string {
  const value = declarations(tokens).get(name);
  if (value === undefined) throw new Error(`missing semantic token ${name}`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference === null) return value;
  const raw = declarations(palette).get(reference[1]!);
  if (raw === undefined) throw new Error(`semantic token ${name} references missing palette entry`);
  return raw;
}

function toLinear(part: number): number {
  const channel = part / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.trim().replace('#', '');
  const full =
    digits.length === 3
      ? [...digits].map((character) => character + character).join('')
      : digits;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return (
    0.2126 * toLinear(Number.parseInt(full.slice(0, 2), 16)) +
    0.7152 * toLinear(Number.parseInt(full.slice(2, 4), 16)) +
    0.0722 * toLinear(Number.parseInt(full.slice(4, 6), 16))
  );
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

const conditions = ['ready', 'scheduled', 'active', 'needs-human', 'error', 'finished'] as const;

describe('Wake design tokens', () => {
  it('assigns every semantic token from the palette layer, not from a literal', () => {
    for (const [name, value] of declarations(tokens))
      if (/#[0-9a-fA-F]{3,6}/.test(value))
        throw new Error(`semantic token ${name} hardcodes ${value}; assign it from palette.css`);
    expect(declarations(tokens).size).toBeGreaterThan(0);
  });

  it('defines the full condition vocabulary', () => {
    for (const condition of conditions) {
      expect(resolve(`--cond-${condition}-fg`)).toMatch(/^#/);
      expect(resolve(`--cond-${condition}-bg`)).toMatch(/^#/);
    }
  });

  it('meets WCAG AA for every condition pair', () => {
    for (const condition of conditions)
      expect(
        contrast(resolve(`--cond-${condition}-fg`), resolve(`--cond-${condition}-bg`)),
      ).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA for body and muted text on every surface', () => {
    for (const surface of ['--surface', '--surface-panel', '--surface-card', '--surface-inset'])
      for (const text of ['--ink', '--ink-muted'])
        expect(contrast(resolve(text), resolve(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA for navigation and link colours on their own bands', () => {
    expect(contrast(resolve('--ink-inverse'), resolve('--brand'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve('--nav-ink-idle'), resolve('--brand-darker'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(resolve('--accent-light'), resolve('--brand-darker'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(resolve('--accent'), resolve('--surface-card'))).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/tokens.test.ts`

Expected: FAIL — `palette.css` does not exist, so the `read` call throws `ENOENT`.

- [ ] **Step 3: Create the palette layer**

Create `src-next/surfaces/web/src/styles/palette.css`:

```css
/* Layer 1: raw values. Only tokens.css may reference these. */
:root {
  --wake-ink-950: #14161a;
  --wake-ink-900: #1a1d23;
  --wake-ink-850: #22262e;
  --wake-ink-800: #101216;
  --wake-ink-700: #2c313a;
  --wake-ink-600: #3a4150;
  --wake-grey-300: #cbd5e1;
  --wake-grey-400: #9aa2ad;
  --wake-grey-100: #e8e8e8;
  --wake-white: #ffffff;

  --wake-teal-700: #103a37;
  --wake-teal-650: #134e4a;
  --wake-teal-600: #0f766e;
  --wake-mint-400: #2dd4bf;
  --wake-mint-300: #5eead4;

  --wake-green-300: #7fe3a3;
  --wake-green-900: #1f3d2c;
  --wake-blue-300: #7fb3ff;
  --wake-blue-900: #1f3350;
  --wake-purple-300: #c79bff;
  --wake-purple-900: #2d1f50;
  --wake-amber-300: #ffcf7f;
  --wake-amber-900: #4a3510;
  --wake-red-300: #ff8f7f;
  --wake-red-900: #3d1f1f;
  --wake-slate-400: #9aa2ad;
  --wake-slate-900: #252830;
}
```

- [ ] **Step 4: Replace the token file with the semantic layer**

Replace the entire contents of `src-next/surfaces/web/src/styles/tokens.css`:

```css
@import './palette.css';

/* Layer 2: semantic tokens. Components reference only these names.
   A light theme adds one :root[data-theme='light'] block here and nothing else. */
:root {
  --surface: var(--wake-ink-950);
  --surface-panel: var(--wake-ink-900);
  --surface-card: var(--wake-ink-850);
  --surface-inset: var(--wake-ink-800);

  --border: var(--wake-ink-700);
  --border-strong: var(--wake-ink-600);

  --ink: var(--wake-grey-100);
  --ink-muted: var(--wake-grey-400);
  --ink-inverse: var(--wake-white);

  --brand: var(--wake-teal-600);
  --brand-dark: var(--wake-teal-650);
  --brand-darker: var(--wake-teal-700);
  --nav-ink-idle: var(--wake-grey-300);

  --accent: var(--wake-mint-400);
  --accent-light: var(--wake-mint-300);

  --good: var(--wake-green-300);
  --warning: var(--wake-amber-300);
  --bad: var(--wake-red-300);

  --cond-ready-fg: var(--wake-green-300);
  --cond-ready-bg: var(--wake-green-900);
  --cond-scheduled-fg: var(--wake-blue-300);
  --cond-scheduled-bg: var(--wake-blue-900);
  --cond-active-fg: var(--wake-purple-300);
  --cond-active-bg: var(--wake-purple-900);
  --cond-needs-human-fg: var(--wake-amber-300);
  --cond-needs-human-bg: var(--wake-amber-900);
  --cond-error-fg: var(--wake-red-300);
  --cond-error-bg: var(--wake-red-900);
  --cond-finished-fg: var(--wake-slate-400);
  --cond-finished-bg: var(--wake-slate-900);

  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;

  --radius: 0.65rem;
  --radius-sm: 0.4rem;
  --shadow: 0 1px 3px rgb(0 0 0 / 0.35);
  --focus-ring: var(--wake-mint-300);

  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  --text-xs: 0.72rem;
  --text-sm: 0.8rem;
  --text-base: 1rem;
  --text-lg: 1.15rem;

  --content-width: 76rem;
  --motion-fast: 0.12s;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/tokens.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/styles/palette.css src-next/surfaces/web/src/styles/tokens.css src-next/surfaces/web/test/tokens.test.ts
git add src-next/surfaces/web/src/styles src-next/surfaces/web/test/tokens.test.ts
git commit -m "feat(web): add a two-layer dark token system with an AA contrast gate"
```

---

### Task 2: Dark base styles and the three-band shell

**Files:**

- Modify: `src-next/surfaces/web/src/styles/global.css`
- Modify: `src-next/surfaces/web/src/components/components.module.css:1-60`
- Modify: `src-next/surfaces/web/src/components/app-shell.tsx:24-36`

**Interfaces:**

- Consumes: all semantic tokens from Task 1.
- Produces: `AppShell` renders a `banner` landmark, a status band with the
  `contentinfo`-free `statusBand` class, and the existing `navigation` landmark
  named `Primary`. Class names `styles.shell`, `styles.header`,
  `styles.statusBand`, `styles.nav`, `styles.main` remain the layout hooks used
  by later tasks.

- [ ] **Step 1: Write the failing shell test**

Add to `src-next/surfaces/web/test/app.test.tsx`, inside the existing
`describe('Wake operator app', ...)` block:

```tsx
  it('separates the brand band from the status band so status is not a nav item', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const banner = await screen.findByRole('banner');
    expect(banner.textContent).toContain('WAKE');
    const status = await screen.findByRole('status', { name: 'Control plane' });
    expect(status.textContent).toContain('Dispatch active');
    expect(within(banner).queryByText('Dispatch active')).toBeNull();
  });
```

Update the import on line 1 of that file to include `within`:

```tsx
import { cleanup, render, screen, within } from '@testing-library/react';
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/app.test.tsx`

Expected: FAIL — no element has role `status` with accessible name `Control plane`; status currently sits inside the header.

- [ ] **Step 3: Restyle the base document**

Replace the contents of `src-next/surfaces/web/src/styles/global.css`:

```css
@import './tokens.css';

* {
  box-sizing: border-box;
}
html {
  color: var(--ink);
  background: var(--surface);
  font-family: var(--font-sans);
  line-height: 1.5;
}
body {
  margin: 0;
}
a {
  color: var(--accent-light);
  text-decoration: none;
  text-underline-offset: 0.18em;
}
a:hover {
  text-decoration: underline;
}
button,
input,
select {
  font: inherit;
}
:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
}
```

- [ ] **Step 4: Restyle the shell bands**

In `src-next/surfaces/web/src/components/components.module.css`, replace the
`.shell`, `.header`, `.brand`, `.nav`, `.nav a`, `.nav a[aria-current='page']`,
and `.main` rules (lines 1-45) with:

```css
.shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto auto auto 1fr;
}
.header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.55rem var(--space-4);
  background: var(--brand);
  color: var(--ink-inverse);
}
.brand {
  color: var(--ink-inverse);
  font-weight: 800;
  font-size: var(--text-lg);
  text-decoration: none;
  letter-spacing: 0.04em;
}
.statusBand {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: 0.45rem var(--space-4);
  background: var(--brand-dark);
  border-top: 1px solid rgb(0 0 0 / 0.18);
  font-size: var(--text-sm);
  color: var(--ink-inverse);
}
.nav {
  display: flex;
  gap: 0.25rem;
  padding: 0.4rem var(--space-4) 0;
  background: var(--brand-darker);
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.nav a {
  color: var(--nav-ink-idle);
  padding: 0.4rem 0.7rem 0.45rem;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  text-decoration: none;
  white-space: nowrap;
  transition: color var(--motion-fast) ease;
}
.nav a:hover {
  color: var(--ink-inverse);
  text-decoration: none;
}
.nav a[aria-current='page'] {
  color: var(--accent-light);
  border-bottom-color: var(--accent);
  font-weight: 700;
}
.main {
  width: min(100% - 2rem, var(--content-width));
  margin: 0 auto;
  padding: var(--space-6) 0;
}
```

- [ ] **Step 5: Move status into its own band**

In `src-next/surfaces/web/src/components/app-shell.tsx`, replace the `header`
and `nav` block (lines 24-36) with:

```tsx
      <header className={styles.header}>
        <NavLink className={styles.brand!} to="/board">
          WAKE
        </NavLink>
      </header>
      <div className={styles.statusBand} role="status" aria-label="Control plane">
        <ControlPlaneStatus />
      </div>
      <nav className={styles.nav} aria-label="Primary">
        {navigation.map(([label, path]) => (
          <NavLink key={path} to={path}>
            {label}
          </NavLink>
        ))}
      </nav>
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS, including the pre-existing shell assertions in `app.test.tsx`.

- [ ] **Step 7: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/styles/global.css src-next/surfaces/web/src/components/components.module.css src-next/surfaces/web/src/components/app-shell.tsx src-next/surfaces/web/test/app.test.tsx
git add src-next/surfaces/web/src src-next/surfaces/web/test
git commit -m "feat(web): adopt the dark three-band control-plane shell"
```

---

### Task 3: Dense presentation primitives

**Files:**

- Create: `src-next/surfaces/web/src/components/chip.tsx`
- Create: `src-next/surfaces/web/src/components/tile.tsx`
- Modify: `src-next/surfaces/web/src/components/primitives.tsx:38-50`
- Modify: `src-next/surfaces/web/src/components/components.module.css` (append)
- Test: `src-next/surfaces/web/test/primitives.test.tsx`

**Interfaces:**

- Produces:
  - `Chip({ children, variant?: 'default' | 'outline' })` — inline dense label.
  - `Tile({ label, value })` — big number over an uppercase caption.

**Deliberately not built:** a condition `Pill` component. Nothing in Phase A has
condition data to put in one, so shipping it would be dead code and
`npm run knip:next` would correctly reject it. The condition *tokens* from Task 1
do stay — they are the theme contract and are covered by the contrast test — but
the component that consumes them belongs to Phase B alongside the board read
model.

`StatusBadge` keeps its existing `'neutral' | 'good' | 'warning' | 'bad'` tones
and is still used by `health.tsx` and `runs.tsx`. Do not remove a tone.

- [ ] **Step 1: Write the failing primitives test**

Create `src-next/surfaces/web/test/primitives.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Chip } from '../src/components/chip.js';
import { Tile } from '../src/components/tile.js';

describe('dense presentation primitives', () => {
  afterEach(cleanup);

  it('renders chips for arbitrary open values without interpreting them', () => {
    render(
      <>
        <Chip>dark-factory</Chip>
        <Chip variant="outline">phase:6</Chip>
      </>,
    );
    expect(screen.getByText('dark-factory')).toBeTruthy();
    expect(screen.getByText('phase:6')).toBeTruthy();
  });

  it('renders a tile as a labelled statistic', () => {
    render(<Tile label="Runs" value="42" />);
    const tile = screen.getByRole('group', { name: 'Runs' });
    expect(tile.textContent).toContain('42');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/primitives.test.tsx`

Expected: FAIL — cannot resolve `../src/components/chip.js`.

- [ ] **Step 3: Implement the chip**

Create `src-next/surfaces/web/src/components/chip.tsx`:

```tsx
import type { ReactNode } from 'react';
import styles from './components.module.css';

export function Chip({
  children,
  variant = 'default',
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'outline';
}) {
  return (
    <span className={`${styles.chip} ${variant === 'outline' ? styles.chipOutline : ''}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Implement the tile**

Create `src-next/surfaces/web/src/components/tile.tsx`:

```tsx
import styles from './components.module.css';

export function Tile({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={styles.tile} role="group" aria-label={label}>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileLabel}>{label}</div>
    </div>
  );
}
```

- [ ] **Step 5: Add the primitive styles**

Append to `src-next/surfaces/web/src/components/components.module.css`:

```css
.chip {
  display: inline-block;
  background: var(--border);
  color: var(--ink);
  border-radius: var(--radius-sm);
  padding: 0.05rem 0.35rem;
  font-size: var(--text-xs);
  margin-right: 0.2rem;
}
.chipOutline {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--ink-muted);
}
.tile {
  background: var(--surface-panel);
  border-radius: var(--radius);
  padding: 0.6rem 0.9rem;
  min-width: 120px;
}
.tileValue {
  font-size: 1.3rem;
  font-weight: 700;
}
.tileLabel {
  color: var(--ink-muted);
  font-size: var(--text-xs);
  text-transform: uppercase;
}
```

- [ ] **Step 6: Restyle the remaining shared surfaces**

In the same file, replace the `.panel`, `.badge`, `.button`, `.secondary`,
`.table th/td`, `.state`, and `.json` rules so they reference dark tokens:

```css
.panel {
  background: var(--surface-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  box-shadow: var(--shadow);
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  font-size: 0.85rem;
  font-weight: 700;
  background: var(--surface-card);
  color: var(--ink);
}
.button {
  appearance: none;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.22rem 0.55rem;
  background: var(--surface-card);
  color: var(--ink);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
}
.button:hover:not(:disabled) {
  border-color: var(--accent-light);
  color: var(--accent-light);
}
.button:disabled {
  opacity: 0.62;
  cursor: wait;
}
.secondary {
  background: transparent;
}
.table th,
.table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.table th {
  color: var(--ink-muted);
  font-weight: 600;
}
.state {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: var(--space-5);
  color: var(--ink-muted);
}
.json {
  overflow: auto;
  background: var(--surface-inset);
  color: var(--ink);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}
```

Then replace the two remaining literals in that file: `.header .live` becomes
`color: var(--warning);`, and `.error` becomes `border-color: var(--bad); color: var(--bad);`.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/components src-next/surfaces/web/test/primitives.test.tsx
git add src-next/surfaces/web/src/components src-next/surfaces/web/test/primitives.test.tsx
git commit -m "feat(web): add chip, pill, and tile primitives on dark tokens"
```

---

### Task 4: Widen the e2e fixture to a representative dataset

The fixture is the only place Phase A can be seen with data until Task 25A wires
live intake, so it is the de-facto design review artifact. One work item cannot
expose density, truncation, or empty-column problems.

**Files:**

- Modify: `src-next/surfaces/web/e2e/surface-fixture.ts:67-84,175-183`

**Interfaces:**

- Consumes: `WorkItemResponse` from `../../api/contracts/index.js` (already imported).
- Produces: `work.list` returns 7 items; `work.detail` resolves every one of them.

**Critical constraint:** `e2e/operator-journey.spec.ts:15` and `:36` locate links
by accessible name, and Playwright's `name` option matches a **substring** by
default. No added objective may contain the text `Demo Wake`, or those locators
become strict-mode violations and the existing journey fails.

- [ ] **Step 1: Add the dataset and confirm the existing journey still passes**

In `src-next/surfaces/web/e2e/surface-fixture.ts`, replace the `workSummary`
function (lines 175-183) with a set builder:

```ts
function workSummary(): WorkItemResponse {
  return {
    workItemKey,
    workItemId: 'work-demo',
    objective: state.advanced ? 'Demo Wake advanced' : 'Demo Wake',
    state: state.advanced ? WorkStatus.Closed : WorkStatus.Open,
    relatedWorkItems: [],
  };
}

/** Review dataset: enough breadth to expose density, truncation, and empty columns.
    No objective may contain "Demo Wake" - the journey locates that link by substring. */
function workItems(): readonly WorkItemResponse[] {
  const extra: readonly (readonly [string, string, string])[] = [
    ['work-refine', 'Refine the intake policy for scheduled workflows', WorkStatus.Open],
    [
      'work-long',
      'Distinguish stall, startup, absolute-timeout, and graceful-cancellation semantics so a watcher can tell a wedged run from a slow one',
      WorkStatus.Open,
    ],
    ['work-review', 'Review pull request feedback', WorkStatus.Open],
    ['work-merged', 'Merge the runner selection change', WorkStatus.Closed],
    ['work-shipped', 'Ship the projection catch-up fix', WorkStatus.Closed],
    ['work-dropped', 'Abandon the duplicate correlation spike', WorkStatus.Cancelled],
  ];
  return [
    workSummary(),
    ...extra.map(([id, objective, itemState]) => ({
      workItemKey: toWorkItemKey(id),
      workItemId: id,
      objective,
      state: itemState,
      relatedWorkItems: [],
    })),
  ];
}
```

Replace the `work` application block (lines 67-84) with:

```ts
  work: {
    async list() {
      const items = workItems();
      return { items, meta: { asOf: instant }, total: items.length };
    },
    async detail(key) {
      const item = workItems().find((candidate) => candidate.workItemKey === key);
      if (item === undefined) return undefined;
      return {
        data: {
          work: item,
          resources:
            item.workItemId === 'work-demo'
              ? [
                  {
                    resourceId: 'resource-1',
                    kind: 'ticket',
                    capabilities: ['comment', 'label'],
                    revision: 'rev-1',
                  },
                  {
                    resourceId: 'resource-2',
                    kind: 'change-proposal',
                    capabilities: ['review', 'merge'],
                  },
                ]
              : [],
          orchestration: { primary: null, children: [] },
          execution: { runs: item.workItemId === 'work-demo' ? [run()] : [] },
          activities: {},
        },
        meta: { asOf: instant },
      };
    },
  },
```

`WorkStatus` is a closed vocabulary with exactly the members this uses —
`Open: 'open'`, `Closed: 'closed'`, `Cancelled: 'cancelled'`
(`src-next/work/contracts/vocabulary.ts:3-6`) — which match the three board
columns. `toWorkItemKey` is already imported by the fixture at line 9.

- [ ] **Step 2: Run the existing e2e journey and confirm it still passes**

Run: `npm run test:e2e --workspace @atolis-hq/wake-web`

Expected: PASS for both `desktop` and `mobile` projects. If a strict-mode
violation appears on the `Demo Wake` locator, an added objective contains that
substring — rename it.

- [ ] **Step 3: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/e2e/surface-fixture.ts
git add src-next/surfaces/web/e2e/surface-fixture.ts
git commit -m "test(web): widen the e2e fixture to a representative review dataset"
```

---

### Task 5: Board columns and card treatment

**Files:**

- Create: `src-next/surfaces/web/src/features/board/board-card.tsx`
- Modify: `src-next/surfaces/web/src/features/board/board.tsx`
- Modify: `src-next/surfaces/web/src/features/features.module.css:1-35`
- Test: `src-next/surfaces/web/test/board.test.tsx`

**Interfaces:**

- Consumes: `Chip` from `../../components/chip.js`.
- Produces: `BoardCard({ item, background })` where `item: WorkItemResponse` and
  `background` is the `useLocation()` return value, used as router modal state.

**Scope reminder:** the board reads `/work-items` only. Do not add a second
query. Condition colour, stage, dwell time, and spend arrive with the Phase B
board read model; the card renders their slots empty until then.

- [ ] **Step 1: Write the failing board test**

Create `src-next/surfaces/web/test/board.test.tsx`:

```tsx
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

const asOf = '2026-07-31T10:00:00.000Z';

function boardClient(fetchSpy?: (url: string) => void) {
  const items = [
    { workItemKey: 'wk_a', workItemId: 'work-a', objective: 'Alpha', state: 'open', relatedWorkItems: [] },
    { workItemKey: 'wk_b', workItemId: 'work-b', objective: 'Beta', state: 'open', relatedWorkItems: [] },
    { workItemKey: 'wk_c', workItemId: 'work-c', objective: 'Gamma', state: 'closed', relatedWorkItems: [] },
  ];
  return new WakeApiClient(async (input) => {
    const url = String(input);
    fetchSpy?.(url);
    const body = url.includes('/work-items')
      ? { items, page: { nextCursor: null, hasMore: false }, meta: { asOf } }
      : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('board', () => {
  afterEach(cleanup);

  it('labels every column with its item count and keeps empty columns visible', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Open (2)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Closed (1)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cancelled (0)' })).toBeTruthy();
  });

  it('renders each card as a link to its work item key route', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('listitem', { name: 'Alpha' });
    expect(within(card).getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe(
      '/work/wk_a',
    );
  });

  it('requests only the work item collection, never a second collection to join', async () => {
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient((url) => seen.push(url))} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Open (2)' });
    expect(seen.filter((url) => url.includes('/workflow-instances'))).toEqual([]);
    expect(seen.filter((url) => url.includes('/resources'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/board.test.tsx`

Expected: FAIL — headings read `Open` without a count, and cards expose no
`listitem` accessible name.

- [ ] **Step 3: Implement the board card**

Create `src-next/surfaces/web/src/features/board/board-card.tsx`:

```tsx
import { Link, useLocation } from 'react-router';
import type { WorkItemResponse } from '../../../../api/contracts/index.js';
import { Chip } from '../../components/chip.js';
import styles from '../features.module.css';

export function BoardCard({
  item,
  background,
}: {
  readonly item: WorkItemResponse;
  readonly background: ReturnType<typeof useLocation>;
}) {
  return (
    <li className={styles.card} aria-label={item.objective}>
      <Link
        className={styles.cardTitle!}
        to={`/work/${encodeURIComponent(item.workItemKey)}`}
        state={{ background }}
      >
        {item.objective}
      </Link>
      {/* Chip row, stats line, and condition border are intentionally sparse:
          stage, dwell time, and spend arrive with the Phase B board read model. */}
      <div className={styles.cardMeta}>
        <Chip variant="outline">{item.state}</Chip>
        {item.relatedWorkItems.length > 0 && (
          <Chip variant="outline">{item.relatedWorkItems.length} related</Chip>
        )}
      </div>
      <div className={styles.cardStats}>{item.workItemId}</div>
    </li>
  );
}
```

- [ ] **Step 4: Rewrite the board feature**

Replace the body of `src-next/surfaces/web/src/features/board/board.tsx` from
line 38 (`const items = ...`) to the end of the file:

```tsx
  const items = query.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Board"
        actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
      />
      {items.length === 0 ? (
        <EmptyState>No work items</EmptyState>
      ) : (
        <div className={styles.board}>
          {boardColumns.map((state) => {
            const columnItems = items.filter((item) => item.state === state);
            return (
              <section className={styles.column} key={state}>
                <div className={styles.columnHeader}>
                  <h2>{`${label(state)} (${columnItems.length})`}</h2>
                </div>
                <ul className={styles.cards}>
                  {columnItems.map((item) => (
                    <BoardCard key={item.workItemKey} item={item} background={location} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

const boardColumns = ['open', 'closed', 'cancelled'] as const;
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
```

Replace the imports at the top of that file so `WorkItemResponse` and the old
`WorkCard` are gone and `BoardCard` is used:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { BoardCard } from './board-card.js';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaleIndicator,
} from '../../components/primitives.js';
import styles from '../features.module.css';
```

- [ ] **Step 5: Restyle the board and card**

In `src-next/surfaces/web/src/features/features.module.css`, replace the
`.board`, `.column`, `.column h2`, `.cards`, `.card`, and `.card a` rules
(lines 1-35) with:

```css
.board {
  display: grid;
  grid-template-columns: repeat(3, minmax(16rem, 1fr));
  gap: 0.6rem;
  overflow-x: auto;
  align-items: start;
}
.column {
  background: var(--surface-panel);
  border-radius: var(--radius);
  padding: 0.5rem;
  min-height: 200px;
}
.columnHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0.2rem 0.4rem 0.5rem;
}
.column h2 {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-muted);
  margin: 0;
}
.cards {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.5rem;
}
.card {
  background: var(--surface-card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 0.5rem;
  padding: 0.5rem;
  font-size: var(--text-sm);
  transition: border-color var(--motion-fast) ease;
}
.card:hover {
  border-color: var(--accent);
}
.cardTitle {
  display: block;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 0.25rem;
}
.cardMeta {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  margin-top: 0.2rem;
}
.cardStats {
  color: var(--ink-muted);
  font-size: 0.7rem;
  margin-top: 0.3rem;
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src src-next/surfaces/web/test/board.test.tsx
git add src-next/surfaces/web/src src-next/surfaces/web/test/board.test.tsx
git commit -m "feat(web): give the board counted columns and dense cards"
```

---

### Task 6: Collapsible board columns

Legacy persists collapse state per column in `localStorage`
(`src/adapters/http/ui-assets.ts:293-320`). The web surface architecture design
§7.2 requires collapsible columns on mobile.

**Files:**

- Modify: `src-next/surfaces/web/src/features/board/board.tsx`
- Modify: `src-next/surfaces/web/src/features/features.module.css` (append)
- Test: `src-next/surfaces/web/test/board.test.tsx` (append)

**Interfaces:**

- Produces: `localStorage` key `wake:board:collapsed-columns` holding a JSON
  array of column names.

- [ ] **Step 1: Write the failing collapse test**

Append inside the `describe('board', ...)` block in
`src-next/surfaces/web/test/board.test.tsx`:

```tsx
  it('collapses a column, hides its cards, and persists the choice', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('button', { name: 'Collapse Open' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(toggle);

    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand Open' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(window.localStorage.getItem('wake:board:collapsed-columns')).toBe('["open"]');
  });

  it('restores collapsed columns from storage on first render', async () => {
    window.localStorage.setItem('wake:board:collapsed-columns', '["closed"]');
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Expand Closed' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Gamma' })).toBeNull();
    window.localStorage.clear();
  });
```

Add the `userEvent` import to the top of that file:

```tsx
import userEvent from '@testing-library/user-event';
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/board.test.tsx`

Expected: FAIL — no `Collapse Open` button exists.

- [ ] **Step 3: Implement collapse state**

Add to `src-next/surfaces/web/src/features/board/board.tsx`, above the `Board`
function:

```tsx
const collapseStorageKey = 'wake:board:collapsed-columns';

function readCollapsed(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(collapseStorageKey);
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(collapseStorageKey, JSON.stringify([...collapsed]));
  } catch {
    // Storage failures must not break the toggle for this render.
  }
}
```

Inside `Board`, add state beneath the existing `useQuery` call:

```tsx
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const toggleColumn = (state: string) => {
    const next = new Set(collapsed);
    if (next.has(state)) next.delete(state);
    else next.add(state);
    writeCollapsed(next);
    setCollapsed(next);
  };
```

Add `useState` to the React import:

```tsx
import { useState } from 'react';
```

- [ ] **Step 4: Render the toggle and honour the state**

Replace the `<section>` body inside the column map with:

```tsx
              <section className={styles.column} key={state}>
                <div className={styles.columnHeader}>
                  <h2>{`${label(state)} (${columnItems.length})`}</h2>
                  <button
                    type="button"
                    className={styles.columnToggle}
                    aria-expanded={!collapsed.has(state)}
                    aria-label={`${collapsed.has(state) ? 'Expand' : 'Collapse'} ${label(state)}`}
                    onClick={() => toggleColumn(state)}
                  >
                    {collapsed.has(state) ? '+' : '−'}
                  </button>
                </div>
                {!collapsed.has(state) && (
                  <ul className={styles.cards}>
                    {columnItems.map((item) => (
                      <BoardCard key={item.workItemKey} item={item} background={location} />
                    ))}
                  </ul>
                )}
              </section>
```

- [ ] **Step 5: Style the toggle**

Append to `src-next/surfaces/web/src/features/features.module.css`:

```css
.columnToggle {
  display: inline-flex;
  width: 1.65rem;
  height: 1.65rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-muted);
  cursor: pointer;
  font-size: var(--text-base);
  line-height: 1;
}
.columnToggle:hover {
  border-color: var(--accent);
  color: var(--accent-light);
}
@media (max-width: 42rem) {
  .board {
    display: block;
    overflow: visible;
  }
  .column {
    margin-bottom: 0.75rem;
    min-height: unset;
  }
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features src-next/surfaces/web/test/board.test.tsx
git add src-next/surfaces/web/src/features src-next/surfaces/web/test/board.test.tsx
git commit -m "feat(web): make board columns collapsible with persisted state"
```

---

### Task 7: Work list restyle

**Files:**

- Modify: `src-next/surfaces/web/src/features/work/work.tsx:94-110`
- Modify: `src-next/surfaces/web/src/features/features.module.css:36-55`

**Interfaces:**

- Consumes: `Chip` from `../../components/chip.js`.

**Scope reminder:** do not add stage or workflow columns. That data is not on
`WorkItemResponse` and arrives with the Phase B board read model, not a join.

- [ ] **Step 1: Restyle the filter controls**

In `src-next/surfaces/web/src/features/features.module.css`, replace the
`.filters input, .filters select` rule with:

```css
.filters label {
  display: grid;
  gap: 0.25rem;
  font-weight: 600;
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
.filters input,
.filters select {
  min-height: 2.35rem;
  background: var(--surface-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--ink);
  padding-inline: 0.55rem;
  font: inherit;
}
.filters input:focus,
.filters select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(45 212 191 / 0.15);
}
```

- [ ] **Step 2: Use a chip for state in the list**

In `src-next/surfaces/web/src/features/work/work.tsx`, replace the `columns`
definition (lines 94-110) with:

```tsx
const columns = (location: ReturnType<typeof useLocation>) => [
  {
    label: 'Work item',
    render: (item: WorkItemResponse) => (
      <Link to={`/work/${encodeURIComponent(item.workItemKey)}`} state={{ background: location }}>
        {item.objective}
      </Link>
    ),
  },
  { label: 'Identity', render: (item: WorkItemResponse) => item.workItemId },
  {
    label: 'State',
    render: (item: WorkItemResponse) => <Chip variant="outline">{item.state}</Chip>,
  },
];
```

Replace the `StatusBadge` import in that file with `Chip`:

```tsx
import { Chip } from '../../components/chip.js';
```

and remove `StatusBadge` from the `primitives.js` import list.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS. `test/collections.test.tsx` asserts table structure, not badge
internals, so it is unaffected.

- [ ] **Step 4: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0. If it reports `StatusBadge` declared but never read, remove
the leftover import.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features
git add src-next/surfaces/web/src/features
git commit -m "feat(web): restyle the work list filters and state column"
```

---

### Task 8: Structured work detail with generic resources

Replaces the five-row `<dl>` plus `JsonViewer(activities)` at
`features/work/work.tsx:134-148`.

**Files:**

- Modify: `src-next/surfaces/web/src/features/work/work.tsx:112-175`
- Modify: `src-next/surfaces/web/src/features/features.module.css:56-70`
- Test: `src-next/surfaces/web/test/work-detail.test.tsx`

**Interfaces:**

- Consumes: `Chip` (Task 3), `LocalTime` from `../../components/local-time.js`,
  `DataTable` from `../../components/data-table.js`.

**Scope reminder:** resources render from `resourceId`, `kind`, and
`capabilities` as open values. No component may branch on a specific kind, infer
a provider, or parse an identifier. No activity-specific section ships, even
though `activities.pullRequest` is present in the contract.

- [ ] **Step 1: Write the failing work detail test**

Create `src-next/surfaces/web/test/work-detail.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

const asOf = '2026-07-31T10:00:00.000Z';

function detailClient() {
  const work = {
    workItemKey: 'wk_a',
    workItemId: 'work-a',
    objective: 'Alpha',
    state: 'open',
    relatedWorkItems: [],
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.includes('/work-items/wk_a')
      ? {
          data: {
            work,
            resources: [
              {
                resourceId: 'resource-1',
                kind: 'unheard-of-kind',
                capabilities: ['inspect', 'annotate'],
                revision: 'rev-9',
              },
            ],
            orchestration: { primary: null, children: [] },
            execution: {
              runs: [
                {
                  runId: 'run-1',
                  activationId: 'activation-1',
                  activity: 'agent',
                  workflowInstanceId: 'workflow-1',
                  orchestrationGroupId: 'group-1',
                  attempt: 1,
                  status: 'succeeded',
                  active: false,
                  startedAt: asOf,
                  finishedAt: asOf,
                },
              ],
            },
            activities: {
              pullRequest: {
                resourceId: 'resource-1',
                state: 'open',
                headRevision: 'abc123',
                baseRevision: 'def456',
                checks: 'passing',
              },
            },
          },
          meta: { asOf },
        }
      : url.includes('/work-items')
        ? { items: [work], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('work detail', () => {
  afterEach(cleanup);

  it('presents labelled sections rather than a raw structure dump', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resources' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Runs' })).toBeTruthy();
  });

  it('renders an unknown resource kind generically, proving no kind-specific branch', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const resources = await screen.findByRole('list', { name: 'Resources' });
    expect(resources.textContent).toContain('unheard-of-kind');
    expect(resources.textContent).toContain('inspect');
    expect(resources.textContent).toContain('annotate');
    expect(resources.textContent).toContain('resource-1');
  });

  it('renders no activity-specific section even when a pull request is present', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Resources' });
    expect(screen.queryByText(/pull request/i)).toBeNull();
    expect(screen.queryByText('abc123')).toBeNull();
    expect(screen.queryByText('def456')).toBeNull();
  });

  it('links each run row to its own route', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'run-1' });
    expect(link.getAttribute('href')).toBe('/runs/run-1');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/work-detail.test.tsx`

Expected: FAIL — there is no `Resources` heading and no `Runs` table; the
current detail renders a `<dl>` and a `JsonViewer`.

- [ ] **Step 3: Replace the detail content**

In `src-next/surfaces/web/src/features/work/work.tsx`, replace the `content`
constant inside `WorkDetail` with:

```tsx
  const content = (
    <div className={styles.detail}>
      {query.isPending ? (
        <LoadingState label="Loading work detail" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <PageHeader
            title={query.data.data.work.objective}
            actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
          />
          <Panel>
            <dl className={styles.summary}>
              <dt>Work identity</dt>
              <dd>{query.data.data.work.workItemId}</dd>
              <dt>State</dt>
              <dd>
                <Chip variant="outline">{query.data.data.work.state}</Chip>
              </dd>
              <dt>Stage</dt>
              <dd>{query.data.data.orchestration.primary?.currentStage ?? 'Not started'}</dd>
              <dt>Workflow</dt>
              <dd>{query.data.data.orchestration.primary?.workflowName ?? '—'}</dd>
            </dl>
          </Panel>

          <section aria-labelledby="work-resources">
            <h2 id="work-resources">Resources</h2>
            {query.data.data.resources.length === 0 ? (
              <EmptyState>No correlated resources</EmptyState>
            ) : (
              <ul className={styles.resourceList} aria-label="Resources">
                {query.data.data.resources.map((resource) => (
                  <li key={resource.resourceId}>
                    <Chip>{resource.kind}</Chip>
                    <span className={styles.resourceId}>{resource.resourceId}</span>
                    {resource.capabilities.map((capability) => (
                      <Chip key={capability} variant="outline">
                        {capability}
                      </Chip>
                    ))}
                    {resource.revision !== undefined && (
                      <span className={styles.resourceId}>{resource.revision}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="work-runs">
            <h2 id="work-runs">Runs</h2>
            {query.data.data.execution.runs.length === 0 ? (
              <EmptyState>No runs</EmptyState>
            ) : (
              <DataTable
                caption="Runs"
                rows={query.data.data.execution.runs}
                rowKey={(run) => run.runId}
                columns={runColumns}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
```

Add the run column definitions beneath `WorkDetail`:

```tsx
const runColumns = [
  {
    label: 'Run',
    render: (run: RunResponse) => (
      <Link to={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</Link>
    ),
  },
  { label: 'Activity', render: (run: RunResponse) => run.activity },
  { label: 'Status', render: (run: RunResponse) => <Chip variant="outline">{run.status}</Chip> },
  { label: 'Started', render: (run: RunResponse) => <LocalTime value={run.startedAt} /> },
];
```

Update the imports at the top of the file:

```tsx
import type { RunResponse, WorkItemResponse } from '../../../../api/contracts/index.js';
import { DataTable } from '../../components/data-table.js';
import { LocalTime } from '../../components/local-time.js';
import { Chip } from '../../components/chip.js';
```

Remove `JsonViewer` from the `primitives.js` import list — it is no longer used
in this file.

- [ ] **Step 4: Style the detail sections**

In `src-next/surfaces/web/src/features/features.module.css`, replace the
`.detail dl`, `.detail dt`, `.detail dd` rules with:

```css
.summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.35rem 0.7rem;
  align-items: baseline;
  margin: 0;
  font-size: var(--text-sm);
}
.summary dt {
  margin: 0;
  color: var(--ink-muted);
}
.summary dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.resourceList {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-4);
}
.resourceList li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.35rem;
  font-size: var(--text-sm);
}
.resourceId {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS, including the existing modal/full-page assertions in
`app.test.tsx`, which locate the objective heading and are unaffected.

- [ ] **Step 6: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features src-next/surfaces/web/test/work-detail.test.tsx
git add src-next/surfaces/web/src/features src-next/surfaces/web/test/work-detail.test.tsx
git commit -m "feat(web): present work detail in labelled sections over generic resources"
```

---

### Task 9: Event card presentation

**Files:**

- Modify: `src-next/surfaces/web/src/features/events/events.tsx:133-140`
- Modify: `src-next/surfaces/web/src/features/features.module.css:71-92`

**Scope reminder:** direction arrows and payload expansion require GAP-06 and
GAP-07 and are not built here. Keep the existing pause, buffer, and resume
behaviour untouched — it is better than legacy's.

- [ ] **Step 1: Restyle the event row markup**

In `src-next/surfaces/web/src/features/events/events.tsx`, replace the `<li>`
inside the `ordered.map` call with:

```tsx
            <li className={styles.event} key={record.id}>
              <LocalTime value={record.occurredAt} />
              <span className={styles.eventType}>{record.type}</span>
              <span className={styles.eventId}>{record.id}</span>
            </li>
```

- [ ] **Step 2: Restyle the event list**

In `src-next/surfaces/web/src/features/features.module.css`, replace the
`.eventList` and `.event` rules with:

```css
.eventList {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  max-height: 60vh;
  overflow-y: auto;
}
.event {
  display: grid;
  grid-template-columns: minmax(11rem, 14rem) minmax(10rem, 1fr) minmax(8rem, 18rem);
  gap: 0.65rem;
  align-items: center;
  background: var(--surface-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.65rem;
  min-height: 2.25rem;
}
.event:hover {
  border-color: var(--border-strong);
}
.event time {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.eventType {
  font-weight: 650;
  font-size: var(--text-sm);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eventId {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 42rem) {
  .event {
    grid-template-columns: minmax(8.5rem, 10rem) minmax(8rem, 1fr);
  }
  .eventId {
    display: none;
  }
}
```

- [ ] **Step 2b: Confirm `LocalTime` is imported**

`events.tsx:7` already imports `LocalTime`. Leave it in place.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS. `test/events.test.tsx` asserts pause/buffer/resume behaviour and
event text, which this markup preserves.

- [ ] **Step 4: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features
git add src-next/surfaces/web/src/features
git commit -m "feat(web): adopt the dense event-card presentation"
```

---

### Task 10: Structured run transcript

`RunDetail` currently renders the transcript through `JsonViewer`, although
`RunTranscriptResponse.entries` is already typed as
`{occurredAt, channel, text}` (`surfaces/api/contracts/execution.ts:19-23`).

**Files:**

- Modify: `src-next/surfaces/web/src/features/runs/runs.tsx:85-108`
- Modify: `src-next/surfaces/web/src/features/features.module.css` (append)
- Test: `src-next/surfaces/web/test/runs.test.tsx`

- [ ] **Step 1: Write the failing transcript test**

Create `src-next/surfaces/web/test/runs.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

const asOf = '2026-07-31T10:00:00.000Z';

function runsClient(available: boolean) {
  const run = {
    runId: 'run-1',
    activationId: 'activation-1',
    activity: 'agent',
    workflowInstanceId: 'workflow-1',
    orchestrationGroupId: 'group-1',
    attempt: 1,
    status: 'succeeded',
    active: false,
    startedAt: asOf,
    finishedAt: asOf,
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.includes('/transcript')
      ? {
          data: {
            runId: 'run-1',
            available,
            entries: available
              ? [
                  { occurredAt: asOf, channel: 'prompt', text: 'Investigate the failure' },
                  { occurredAt: asOf, channel: 'result', text: 'wake-result DONE' },
                ]
              : [],
          },
          meta: { asOf },
        }
      : url.includes('/runs/run-1')
        ? { data: run, meta: { asOf } }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('run detail', () => {
  afterEach(cleanup);

  it('renders transcript entries as structured records, not raw JSON', async () => {
    render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <App client={runsClient(true)} />
      </MemoryRouter>,
    );
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    expect(transcript.textContent).toContain('prompt');
    expect(transcript.textContent).toContain('Investigate the failure');
    expect(transcript.textContent).toContain('wake-result DONE');
    expect(screen.queryByText('Structured details')).toBeNull();
  });

  it('states plainly when a transcript is unavailable', async () => {
    render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <App client={runsClient(false)} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Transcript unavailable')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test --workspace @atolis-hq/wake-web -- test/runs.test.tsx`

Expected: FAIL — there is no list named `Transcript`; entries render inside a
`JsonViewer` `<details>` labelled `Structured details`.

- [ ] **Step 3: Replace the transcript rendering**

In `src-next/surfaces/web/src/features/runs/runs.tsx`, replace the `<Panel>`
body inside `RunDetail` with:

```tsx
          <Panel>
            <StatusBadge>{run.data.data.status}</StatusBadge>
            <dl className={styles.summary}>
              <dt>Activity</dt>
              <dd>{run.data.data.activity}</dd>
              <dt>Attempt</dt>
              <dd>{run.data.data.attempt}</dd>
              <dt>Started</dt>
              <dd>
                <LocalTime value={run.data.data.startedAt} />
              </dd>
              {run.data.data.finishedAt !== undefined && (
                <>
                  <dt>Finished</dt>
                  <dd>
                    <LocalTime value={run.data.data.finishedAt} />
                  </dd>
                </>
              )}
            </dl>
            {(run.data.data.outcome ?? run.data.data.failure) !== undefined && (
              <JsonViewer value={run.data.data.outcome ?? run.data.data.failure} />
            )}
            <h2>Transcript</h2>
            {transcript.data?.data.available ? (
              <ol className={styles.transcript} aria-label="Transcript">
                {transcript.data.data.entries.map((entry, index) => (
                  <li className={styles.transcriptEntry} key={`${entry.occurredAt}-${index}`}>
                    <div className={styles.transcriptHead}>
                      <span>{entry.channel}</span>
                      <LocalTime value={entry.occurredAt} />
                    </div>
                    <pre className={styles.transcriptText}>{entry.text}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState>Transcript unavailable</EmptyState>
            )}
          </Panel>
```

Add the styles import to that file:

```tsx
import styles from '../features.module.css';
```

- [ ] **Step 4: Style the transcript**

Append to `src-next/surfaces/web/src/features/features.module.css`:

```css
.transcript {
  list-style: none;
  padding: 0;
  margin: var(--space-3) 0 0;
}
.transcriptEntry {
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 0.75rem;
  overflow: hidden;
}
.transcriptHead {
  display: flex;
  gap: var(--space-3);
  color: var(--ink-muted);
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border);
  padding: 0.45rem 0.6rem;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.transcriptText {
  white-space: pre-wrap;
  margin: 0;
  padding: 0.6rem;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 0.76rem;
  overflow-x: auto;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features src-next/surfaces/web/test/runs.test.tsx
git add src-next/surfaces/web/src/features src-next/surfaces/web/test/runs.test.tsx
git commit -m "feat(web): render run transcripts as structured entries"
```

---

### Task 11: Observability tiles, health, and configuration

**Files:**

- Modify: `src-next/surfaces/web/src/features/observability/observability.tsx:38-47`
- Modify: `src-next/surfaces/web/src/features/features.module.css` (append)

**Scope reminder:** no charts. The analytics read model is Phase B (GAP-13); its
treatment stays tabular. Health and Configuration need no markup change — they
inherit the dark panel, table, and `json` styles from Task 3.

- [ ] **Step 1: Render metrics as tiles**

In `src-next/surfaces/web/src/features/observability/observability.tsx`,
replace the metric grid block with:

```tsx
        <div className={styles.tiles}>
          {Object.entries(query.data!.data.values).map(([name, value]) => (
            <Tile key={name} label={name} value={String(value)} />
          ))}
        </div>
```

Replace the `Panel` import usage with the `Tile` import:

```tsx
import { Tile } from '../../components/tile.js';
```

Remove `Panel` from the `primitives.js` import list if it becomes unused.

- [ ] **Step 2: Style the tile row and delete the rules it replaces**

Append to `src-next/surfaces/web/src/features/features.module.css`:

```css
.tiles {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}
```

Then delete the now-unreferenced `.metricGrid` and `.metric` rules from the same
file — `Tile` replaces both.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `npm run test --workspace @atolis-hq/wake-web`

Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `npm run build --workspace @atolis-hq/wake-web`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/src/features
git add src-next/surfaces/web/src/features
git commit -m "feat(web): present observability metrics as stat tiles"
```

---

### Task 12: Accessibility and full-suite verification

**Files:**

- Modify: `src-next/surfaces/web/e2e/operator-journey.spec.ts` (append one test)

- [ ] **Step 1: Add a board interaction and contrast check to the journey**

Append to `src-next/surfaces/web/e2e/operator-journey.spec.ts`:

```ts
test('keeps the restyled board operable and free of serious accessibility faults', async ({
  page,
}) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: /^Open \(\d+\)$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Cancelled \(\d+\)$/ })).toBeVisible();

  const collapse = page.getByRole('button', { name: 'Collapse Open' });
  await collapse.click();
  await expect(page.getByRole('button', { name: 'Expand Open' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand Open' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run the e2e suite in both viewports**

Run: `npm run test:e2e --workspace @atolis-hq/wake-web`

Expected: PASS for `desktop` and `mobile`. Colour-contrast violations reported
by axe indicate a token pair that Task 1's unit test does not cover — add the
pair to `test/tokens.test.ts` and correct the palette value rather than
suppressing the rule.

- [ ] **Step 3: Run the full unit suite and build**

Run:

```bash
npm run test --workspace @atolis-hq/wake-web
npm run build --workspace @atolis-hq/wake-web
```

Expected: both exit 0.

- [ ] **Step 4: Run the repository gates**

Run:

```bash
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
```

Expected: all exit 0. `knip:next` may report the removed `WorkCard` helper or an
unused `JsonViewer`/`StatusBadge` import as dead code — delete the symbol rather
than adding an ignore entry.

- [ ] **Step 5: Commit**

```bash
npx prettier --write --end-of-line lf src-next/surfaces/web/e2e/operator-journey.spec.ts
git add src-next/surfaces/web/e2e/operator-journey.spec.ts
git commit -m "test(web): cover restyled board operation and accessibility in both viewports"
```

---

## Definition of done

- All twelve tasks committed.
- `npm run test --workspace @atolis-hq/wake-web` passes.
- `npm run test:e2e --workspace @atolis-hq/wake-web` passes for desktop and mobile.
- `npm run verify:next`, `npm run lint:contracts`, `npm run lint:architecture`, and `npm run knip:next` pass.
- `git diff --stat main -- src-next` shows changes only under `src-next/surfaces/web/`.
- No literal colour value remains outside `src/styles/palette.css`, enforced by `test/tokens.test.ts`.

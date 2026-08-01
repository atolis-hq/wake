# Wake Task 25C — Lint and Style Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `src-next/` and `test-next/` onto the TypeScript community's
standard lint and formatting baseline — deterministic line endings, deduplicated
and ordered imports, blank-line separation between declarations, enforced
type-only imports, size budgets that distinguish declarative contracts from
behavioural code, and type-aware correctness rules — without changing any
runtime behaviour.

**Architecture:** Prettier keeps sole ownership of formatting; ESLint takes
ownership of the blank-line and import concerns Prettier deliberately declines
to manage. Steps 1–5 are mechanically auto-fixable and semantically inert, and
each lands as its own reviewable commit. Step 6 is a measurement gate: it
produces per-rule violation counts for type-aware linting before step 7 decides
how much of it to adopt. Every new rule is proven by an ESLint-driven
architecture test in the style of the existing
`test-next/architecture/eslint-contract-boundaries.test.ts`, so the
configuration is verified by the suite rather than by inspection.

**Tech Stack:** Node.js 24+, TypeScript 6, ESLint 10 flat config,
typescript-eslint 8, `@stylistic/eslint-plugin`, `eslint-config-prettier`,
`prettier-plugin-organize-imports`, `@vitest/eslint-plugin`, Prettier 3,
Vitest 4.

---

## Numbering note

This task is **25C, not 25B**. `25B` is already reserved by the Task 25A stub in
the parent plan for provider and runner fidelity plus manual real-GitHub
acceptance, and
[`2026-08-01-wake-task-25a-live-runtime-parity.md`](2026-08-01-wake-task-25a-live-runtime-parity.md)
cross-references "25B step 10", "25B step 11", and "25B step 12" in its findings
and steps. Renumbering this task to 25B would break those references.

## Authority

- Findings and measurements:
  [`docs/reports/2026-08-01-src-next-structural-review.md`](../../reports/2026-08-01-src-next-structural-review.md)
  (§3 on `max-lines`, F10 on the missing type-aware rules).
- `CLAUDE.md` for repository conventions.

## Global Constraints

- **Zero semantic change in steps 1–5.** If an auto-fix alters behaviour, stop
  and record it in §Findings rather than accepting the diff.
- Do not begin this task while Task 25A is mid-flight. Steps 2–5 rewrite import
  blocks and whitespace across most of `src-next/`, which would conflict with
  every open 25A edit. Start only when 25A is committed and green.
- Never import `src/**` from `src-next/**`, or `test/**` from `test-next/**`.
- Prettier owns formatting. Do not enable `@stylistic` rules that duplicate a
  Prettier concern (`indent`, `quotes`, `semi`, `comma-dangle`, `max-len`). Only
  the blank-line rules are in scope.
- Do not add a lint baseline, suppression file, or list of current violations.
  A rule is either enabled and clean, or deferred with a recorded reason.
- Every step ends green on `npm run lint:contracts`, `npm run lint:architecture`,
  `npm run knip:next`, `npm run verify:next`, and `npm run verify`.
- Write files with `npx prettier --write --end-of-line lf <file>`.

**Measured baseline (read-only survey, 2026-08-01, 266 files in `src-next/`
excluding `surfaces/web/`):**

| Signal                                                       | Value           |
| ------------------------------------------------------------ | --------------- |
| Files importing the same module twice                        | 28              |
| Files importing an external package after a relative import  | 11              |
| Declarations with no preceding blank line                    | 210 of 1,171 (17%) |
| Blank lines as a share of all lines                          | 6% (1,014 / 15,863) |
| Type-only imports vs inline `{ type X }` specifiers          | 375 vs 9        |
| Violations under `recommendedTypeChecked`                    | **not measured — step 6** |

Re-confirm the first five before starting; they only shrink.

---

## Task 25C: Adopt the community lint and style baseline

**Files:**

- Create: `.gitattributes`
- Modify: `.prettierrc.json`
- Modify: `package.json`
- Modify: `eslint.config.js`
- Modify: `CLAUDE.md`
- Create: `test-next/architecture/eslint-style-baseline.test.ts`
- Modify: `src-next/**/*.ts`, `test-next/**/*.ts` (auto-fix only)
- Modify: `src-next/{orchestration,activities,execution}/contracts/*.ts` (step 5)

**Interfaces:**

- Consumes: the existing flat config's five override blocks and the
  `ESLint.lintText` fixture pattern from
  `test-next/architecture/eslint-contract-boundaries.test.ts`.
- Produces: no runtime exports. Later tasks inherit the rule set and must keep
  `npm run lint:next` green.

---

- [ ] **Step 1: Make line endings deterministic**

This goes first. Every later step produces a large whitespace diff, and doing
those on top of an ambiguous line-ending setup makes each one unreviewable.

The repository has `core.autocrlf=true`, **no `.gitattributes`**, and
`"endOfLine": "auto"` in `.prettierrc.json`. That combination is the documented
cause of the `format:check` false positives described in `CLAUDE.md`: with
`auto`, Prettier accepts whatever the working copy happens to contain, so the
check result depends on how git materialised the file rather than on its
content.

Create `.gitattributes`:

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.ico binary
```

Set `"endOfLine": "lf"` in `.prettierrc.json`, replacing `"auto"`.

Renormalise and confirm:

```powershell
git add --renormalize .
npm run format:check
```

Expected: `format:check` passes with no false positives on untouched files.

Then delete the CRLF caveat from the `npm run verify` line in `CLAUDE.md` — the
sentence beginning "On Windows with `core.autocrlf=true`, `format:check` reports
false positives" through "and was written with `npx prettier --write
--end-of-line lf <file>`". Keep the rest of that line, including the instruction
not to skip the lint step.

```powershell
git add .gitattributes .prettierrc.json CLAUDE.md
git commit -m "build: make line endings deterministic"
```

- [ ] **Step 2: Deduplicate and order imports**

28 files import from the same module twice —
`src-next/kernel/contracts/event-schema.ts` imports `./events.js` on line 1 and
again on line 3; `src-next/activities/pr/contracts.ts` doubles two modules; all
four `src-next/integrations/github/**` sources double `../../../kernel/index.js`.
A further 11 files import an external package after a relative one.

Install and register the Prettier plugin, which uses the TypeScript language
service to sort and deduplicate in a single pass:

```powershell
npm install --save-dev prettier-plugin-organize-imports
```

Add to `.prettierrc.json`:

```json
{
  "plugins": ["prettier-plugin-organize-imports"],
  "endOfLine": "lf",
  "printWidth": 100,
  "singleQuote": true,
  "trailingComma": "all"
}
```

Run and inspect:

```powershell
npm run format
git diff --stat
```

Expected: import blocks only. **Verify no non-import lines changed** — the
language service also drops imports it considers unused, so scan the diff for
any removed import that a type position still needs.

Risk: the plugin resolves a `tsconfig.json` per file, and this repository has
both `tsconfig.json` (for `src/`) and `tsconfig.next.json` (for `src-next/`). If
imports in `src-next/` are left untouched or are mangled, abandon the plugin and
use `eslint-plugin-import-x` instead, enabling only `import-x/no-duplicates` and
`import-x/order` with `groups: ['builtin', 'external', 'parent', 'sibling', 'index']`.
Record which route was taken in §Findings.

```powershell
npm run verify:next
git add .prettierrc.json package.json package-lock.json src-next test-next
git commit -m "style: deduplicate and order imports"
```

- [ ] **Step 3: Write the failing style-baseline test**

Create `test-next/architecture/eslint-style-baseline.test.ts`:

```ts
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root });
const fixturePath = 'src-next/work/domain/style-fixture.ts';

async function ruleIds(source: string, prefix: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(source, { filePath: fixturePath });
  return result!.messages
    .map(({ ruleId }) => ruleId)
    .filter((ruleId): ruleId is string => ruleId?.startsWith(prefix) === true);
}

describe('style baseline', () => {
  it('requires a blank line between multi-line class members', async () => {
    const source = [
      'export class Probe {',
      '  first(): number {',
      '    return 1;',
      '  }',
      '  second(): number {',
      '    return 2;',
      '  }',
      '}',
    ].join('\n');

    await expect(ruleIds(source, '@stylistic/')).resolves.toEqual([
      '@stylistic/lines-between-class-members',
    ]);
  });

  it('requires a blank line before a function declaration', async () => {
    const source = [
      'const seed = 1;',
      'export function probe(): number {',
      '  return seed;',
      '}',
    ].join('\n');

    await expect(ruleIds(source, '@stylistic/')).resolves.toEqual([
      '@stylistic/padding-line-between-statements',
    ]);
  });

  it('requires a type-only import to be declared with import type', async () => {
    const source = [
      "import { WorkItemView } from '../contracts/views.js';",
      'export type Alias = WorkItemView;',
    ].join('\n');

    await expect(ruleIds(source, '@typescript-eslint/consistent-type-imports')).resolves.toEqual([
      '@typescript-eslint/consistent-type-imports',
    ]);
  });
});
```

- [ ] **Step 4: Run the test and confirm the rules are absent**

```powershell
npx vitest run --config vitest.next.config.ts test-next/architecture/eslint-style-baseline.test.ts
```

Expected: FAIL. All three cases resolve to `[]` because no `@stylistic` plugin
is registered and `consistent-type-imports` is not enabled.

- [ ] **Step 5: Enable the blank-line and type-import rules**

```powershell
npm install --save-dev @stylistic/eslint-plugin eslint-config-prettier
```

Add to `eslint.config.js`. Import `stylistic from '@stylistic/eslint-plugin'`
and `eslintConfigPrettier from 'eslint-config-prettier/flat'`, then append two
blocks — the guardrail block **last**, so it can disable anything that collides
with Prettier:

```js
{
  files: ['src-next/**/*.ts', 'test-next/**/*.ts'],
  plugins: { '@stylistic': stylistic },
  rules: {
    '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
    '@stylistic/padding-line-between-statements': [
      'error',
      { blankLine: 'always', prev: '*', next: ['function', 'class', 'interface', 'type'] },
      { blankLine: 'always', prev: ['function', 'class', 'interface', 'type'], next: '*' },
      { blankLine: 'always', prev: 'import', next: '*' },
      { blankLine: 'any', prev: 'import', next: 'import' },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
    ],
  },
},
eslintConfigPrettier,
```

Do **not** add `{ blankLine: 'always', prev: '*', next: 'return' }` or padding
around variable declarations. Those are where this rule becomes noisy and they
are not community consensus; intra-function grouping stays an author decision.

Apply and verify:

```powershell
npx eslint --fix src-next test-next
npm run format
npx vitest run --config vitest.next.config.ts test-next/architecture/eslint-style-baseline.test.ts
```

Expected: the three cases PASS. `consistent-type-imports` should produce a
diff of roughly 9 lines, since type-only import adoption is already 375 to 9.

```powershell
npm run verify:next
git add eslint.config.js package.json package-lock.json test-next src-next
git commit -m "style: separate declarations and enforce type-only imports"
```

- [ ] **Step 6: Differentiate the size budget and collapse the contract clusters**

The uniform `max-lines: 300` cap applies identical pressure to declarative
contracts and to behavioural code. On the contracts side it produced satellite
files named for their role as fragments rather than for any concept. Their
combined effective line counts are 572 (orchestration), 648 (activities), and
429 (execution), so raising the cap to 400 would recombine nothing and raising
it to 650 would be indefensible for application code.

Replace the single `src-next/**/*.ts` `max-lines` block with two:

```js
{
  files: ['src-next/**/contracts/**/*.ts'],
  rules: {
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
  },
},
{
  files: ['src-next/**/{application,domain,infrastructure}/**/*.ts'],
  rules: {
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
  },
},
```

Keep `max-lines-per-function` at 80 everywhere. It is doing useful work and no
evidence suggests otherwise.

Then collapse the clusters, merging by concept:

- `orchestration/contracts/`: fold `event-types.ts` into `events.ts`, and
  `event-payload-schema.ts` plus `event-envelope-schema.ts` into
  `event-decoder.ts`. Five files become two.
- `activities/contracts/`: fold `event-fact-schemas.ts` into `event-schema.ts`.
  Three files become two.
- `execution/contracts/`: fold `event-schema-components.ts` into `events.ts`.
  Three files become two.

Update the barrel `index.ts` of each module and every importer. Delete the
merged files rather than leaving re-export shims. Any file that still needs
splitting afterwards must be named for its concept, never for its role as a
fragment.

```powershell
npm run knip:next
npm run verify:next
git add eslint.config.js src-next test-next
git commit -m "refactor: size contracts by concept rather than overflow"
```

- [ ] **Step 7: Measure type-aware linting before adopting it**

`typescript-eslint` is already a dependency, so `recommendedTypeChecked` costs
no new package — but its violation count is unmeasured and could plausibly be
anywhere from a handful to several hundred. Measure before deciding.

Create a throwaway `eslint.probe.mjs` at the repository root:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dist*/**', 'src/**', 'test/**', 'scripts/**', 'src-next/surfaces/web/**'] },
  {
    files: ['src-next/**/*.ts', 'test-next/**/*.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
```

Note: `projectService` and `project` are mutually exclusive in
typescript-eslint 8 — setting both is a parse error reading
"Enabling `project` does nothing when `projectService` is enabled."

```powershell
npx eslint --config eslint.probe.mjs --no-config-lookup src-next test-next --format json > probe.json
```

Tabulate counts per `ruleId` and record them in §Findings. Then delete
`eslint.probe.mjs` and `probe.json`; neither is committed.

- [ ] **Step 8: Adopt type-aware rules**

Extend the `**/*.ts` block from `tseslint.configs.recommended` to
`tseslint.configs.recommendedTypeChecked`, add `parserOptions.projectService`,
and enable the one rule this codebase most directly benefits from:

```js
'@typescript-eslint/switch-exhaustiveness-check': 'error',
```

That rule matters here because the codebase folds events through
`switch (owned.eventType)` and currently guards exhaustiveness with a
hand-rolled `assertNever(value: never)` — see
`src-next/work/application/work-projection.ts`. The rule enforces the same
guarantee across every fold without the manual helper.

`no-floating-promises` is the other high-value rule this unlocks, in a codebase
that is asynchronous throughout.

**Landmine — read before running.** The existing
`test-next/architecture/eslint-contract-boundaries.test.ts` and the new
`eslint-style-baseline.test.ts` both call `ESLint.lintText` with fixture paths
that do not exist on disk (`restricted-fixture.ts`, `allowed-fixture.ts`,
`style-fixture.ts`). Once `projectService` is enabled, type-aware rules reject
files absent from the project and both suites will fail with a parse error.
Exclude the fixtures from the type-checked block:

```js
{
  files: ['src-next/**/*-fixture.ts', 'test-next/**/*-fixture.test.ts'],
  extends: [tseslint.configs.disableTypeChecked],
},
```

If step 7 showed a violation count too large to clear inside this task, enable
`switch-exhaustiveness-check` alone, record the deferred rules and their counts
in §Findings, and raise them as a follow-up rather than adding suppressions.

```powershell
npm run verify:next
git add eslint.config.js src-next test-next
git commit -m "build: enable type-aware linting"
```

- [ ] **Step 9: Add test-file hygiene rules**

122 test files currently have no test-specific linting. The structural review
found a permanently-green assertion on `'work.created'`, an event type that does
not exist, which this tier would not itself catch but which shows the class of
defect that goes unnoticed.

```powershell
npm install --save-dev @vitest/eslint-plugin
```

Add a `test-next/**/*.ts` block enabling `vitest/no-focused-tests`,
`vitest/no-disabled-tests`, `vitest/no-identical-title`, and
`vitest/expect-expect`.

```powershell
npm run verify:next
git add eslint.config.js package.json package-lock.json test-next
git commit -m "test: enforce vitest hygiene rules"
```

- [ ] **Step 10: Record the final state**

Append to §Findings: the route taken in step 2, the step 7 measurements, any
rule deferred with its count and reason, and the file/test counts reported by
`npm run verify:next` before and after.

```powershell
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all green, with test counts unchanged apart from the three cases added
in step 3.

---

## Deliberately out of scope

- **Extending the contract-vocabulary lint and dependency-cruiser to
  `test-next/`** (structural review F3). That is a semantic change to 256 raw
  event-type literals across 36 files, not a formatting change, and it belongs
  in its own task alongside the `'work.created'` correction.
- **`eslint-plugin-unicorn`, `sonarjs`, `n`.** Popular but not consensus; each
  needs a deliberate decision rather than inclusion in a baseline.
- **`strictTypeChecked`.** Revisit once `recommendedTypeChecked` has been clean
  for a full task cycle.
- **Any `@stylistic` rule that duplicates a Prettier concern.**

## Findings

Record deviations, deferred rules with counts, and the step 7 measurements here
as the task proceeds.

- Step 2 used `prettier-plugin-organize-imports` successfully.
- Step 7 measurement required target-local `tsconfig.json` discovery files for
  `projectService`. The measured recommended-type-checked violations were:
  `require-await` 196, `no-unsafe-assignment` 27, `unbound-method` 9,
  `no-unused-vars` 8, `no-unnecessary-type-assertion` 6,
  `no-unsafe-return` 2, `prefer-promise-reject-errors` 2, and one each of
  `no-redundant-type-constituents`, `restrict-template-expressions`,
  `no-unsafe-argument`, and `only-throw-error`; those rules are deferred for
  a follow-up rather than suppressed. `switch-exhaustiveness-check` is adopted.

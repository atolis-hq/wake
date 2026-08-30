import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const fullJournalRescanRule = {
  selector:
    'CallExpression[callee.property.name="readAll"][arguments.0.type="Literal"][arguments.0.value=0]',
  message:
    'readAll(0) re-derives the full event history on every call. Route it through ' +
    'cachedJournalView() (src/persistence) so a resident loop only pays that cost ' +
    'when the journal has actually moved since the last call.',
};

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'archive/legacy/**',
      'node_modules/**',
      '.wake/**',
      '.claude/worktrees/**',
      '.worktrees/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-params': ['error', 6],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    files: [
      'src/**/*-fixture.ts',
      'test/**/*-fixture.test.ts',
      'src/surfaces/web/**/*.ts',
      'vitest.config.ts',
      'vitest.unit.config.ts',
      'vitest.architecture.config.ts',
      'vitest.integration.config.ts',
      'vitest.e2e.config.ts',
      'vitest.live-e2e.config.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/**/contracts/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/**/{application,domain,infrastructure}/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    plugins: { vitest },
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'expectTypeOf', 'expectCoordinationMetadata'] },
      ],
    },
  },
  {
    files: ['src/{work,resources,activities,orchestration,execution}/{domain,application}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/kernel/index.js', '**/kernel/contracts/*.js'],
              importNames: ['EventData', 'EventEnvelope', 'entityRef'],
              message: 'Use the owning domain event union and stream constructor.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.type="Identifier"][callee.name="String"]',
          message: 'Decode typed domain values instead of calling String().',
        },
        {
          selector: 'CallExpression[callee.type="Identifier"][callee.name="Number"]',
          message: 'Decode typed domain values instead of calling Number().',
        },
        fullJournalRescanRule,
      ],
    },
  },
  {
    // Everything else journal-adjacent that isn't already covered by the
    // block above (which owns 'no-restricted-syntax' for its own file
    // scope — flat config replaces, not merges, a rule's value across
    // overlapping blocks, so this scope must stay disjoint from that one).
    files: ['src/**/*.ts'],
    ignores: [
      'src/{work,resources,activities,orchestration,execution}/{domain,application}/**/*.ts',
      // Own the journal and already gate full rescans behind a
      // last-seen-position check (durable projection subscriptions and
      // cachedJournalView, the shared primitive every other fix in this file routes through).
      'src/persistence/**',
      'src/kernel/infrastructure/cached-journal-view.ts',
      // Composition/wiring and CLI command handlers: startup and one-off
      // command volume, not a resident tick.
      'src/bootstrap/**',
      'src/surfaces/cli/**',
      // Fake/test adapter, not production polling.
      'src/integrations/fake/**',
      // Bounded by actual pr.merge command volume, not a resident tick.
      // (A plain file, not under {domain,application}/, so block 1 above
      // doesn't already cover it.)
      'src/activities/pr/application.ts',
      // Bounded by actual agent-activation volume, not a resident tick.
      'src/integrations/github/application/comment-history-reader.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', fullJournalRescanRule],
    },
  },
  eslintConfigPrettier,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['function', 'class', 'interface', 'type'] },
        { blankLine: 'always', prev: '*', next: 'export' },
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
);

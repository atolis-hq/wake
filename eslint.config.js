import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'dist-next/**',
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
              importNames: ['EventDraft', 'EventEnvelope', 'entityRef'],
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
      ],
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

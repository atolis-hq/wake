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
      'node_modules/**',
      '.wake/**',
      '.claude/worktrees/**',
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
    files: ['src-next/**/*.ts', 'test-next/**/*.ts'],
    rules: {
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    files: [
      'src-next/**/*-fixture.ts',
      'test-next/**/*-fixture.test.ts',
      'src-next/surfaces/web/**/*.ts',
      'vitest.next.config.ts',
      'vitest.next.e2e.config.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
  },
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
  {
    files: ['test-next/**/*.ts'],
    plugins: { vitest },
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
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
    files: [
      'src-next/{work,resources,activities,orchestration,execution}/{domain,application}/**/*.ts',
    ],
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
    files: ['src-next/**/*.ts', 'test-next/**/*.ts'],
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

import js from '@eslint/js';
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
    },
  },
  {
    files: ['src-next/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['test-next/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
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
);

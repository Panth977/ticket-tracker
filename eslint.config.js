// Flat config for the whole monorepo. Type-aware rules are deliberately off:
// they are slow across four packages and `pnpm typecheck` already covers types.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import svelteConfig from './frontend/svelte.config.js';

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'backend/lib/**',
      'backend/deploy/**',
      'frontend/build/**',
      'frontend/.svelte-kit/**',
      'qaqc/test-results/**',
      'qaqc/playwright-report/**',
      'docs/**',
      'orch/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
);

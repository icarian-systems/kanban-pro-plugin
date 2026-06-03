/**
 * ESLint flat config (ESLint v9).
 *
 * Goals:
 *   - Wire the @typescript-eslint parser so we can lint .ts/.tsx.
 *   - Enable the custom `kanban/no-board-subscription` rule across the
 *     UI and View layers. The core store is exempt — it's the canonical
 *     owner of the board reference.
 *   - Stay surgical. We're not turning on the full @typescript-eslint
 *     recommended set in this commit; that's QA's call, and they own
 *     CI gating. Today's job is the selector contract.
 */
'use strict';

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const noBoardSubscription = require('./eslint-rules/no-board-subscription.js');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  {
    ignores: [
      'main.js',
      'node_modules/**',
      'docs/**',
      'mockup.html',
      'scripts/**',
      'vitest.setup.ts',
      'vitest.config.ts',
      'esbuild.config.mjs',
      'eslint.config.js',
      'eslint-rules/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      kanban: {
        rules: {
          'no-board-subscription': noBoardSubscription,
        },
      },
    },
    rules: {
      // Selector contract — see eslint-rules/no-board-subscription.js.
      'kanban/no-board-subscription': 'error',
    },
  },
  {
    // Carve-out: the store IS the owner of `state.board`. It must read it.
    files: ['src/core/store.ts'],
    rules: {
      'kanban/no-board-subscription': 'off',
    },
  },
  {
    // Tests poke at internals — don't gate them.
    files: ['src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'kanban/no-board-subscription': 'off',
    },
  },
];

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Skip `.claude/worktrees/*` — Claude Code creates physical git worktrees
    // under that path which contain their own copy of `src/` and `__tests__/`.
    // Without this exclude, vitest discovers and runs both copies (the
    // main repo's and the worktree's), which (a) doubles test runtime and
    // (b) reports failures from stale snapshots whenever a worktree branch
    // diverges from the main checkout.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/__tests__/**'],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
      obsidian: '/src/__mocks__/obsidian.ts',
    },
    // D6 — make sure any future ESM importer of `@codemirror/*` collapses
    // to a single physical copy in test runs. Today the `useCM6Editor`
    // hook detects non-Obsidian runtimes and skips the require() entirely,
    // so this is a belt-and-suspenders guard rather than a load-bearing
    // alias.
    dedupe: ['@codemirror/state', '@codemirror/view', '@codemirror/commands'],
  },
});

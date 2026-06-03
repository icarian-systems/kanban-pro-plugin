#!/usr/bin/env node
/**
 * checkLeaks.mjs
 *
 * Runs the lifecycle vitest suite verbose and greps the output for any
 * heuristic leak indicators. The actual assertions live in
 * src/__tests__/lifecycle/lifecycle.test.ts — this is a thin wrapper that
 * also fails on any "leak:" line emitted via console.warn from the tests
 * (some surfaces, like detached DOM, are easier to flag-from-the-side than
 * to assert directly).
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vitest');

const args = [
  'run',
  '--reporter=verbose',
  '--dir',
  'src/__tests__/lifecycle',
];

const res = spawnSync(VITEST_BIN, args, {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});

const stdout = res.stdout ?? '';
const stderr = res.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

// Strip vitest reporter lines (test names, file headers, summary) so that
// leak indicators in test descriptions don't self-trigger. We only want to
// scan console.warn / console.error output emitted by the tests themselves.
//
// CI sets FORCE_COLOR=1, so vitest's verbose reporter emits ANSI escape codes
// inline with the bullet glyph (e.g. `[32m ✓[39m src/...`). The
// ANSI strip must happen before the reporter-line filter, otherwise the line
// reads as starting with ESC and the `^\s*[✓...]` class doesn't match —
// leaving the test name in the scan window, where its description
// ("no dnd-kit DndContext remains active after onunload") trips the regex.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;
const REPORTER_LINE = /^\s*(?:[✓×❯⎯·∙↓→]|RUN |Test Files|Tests |Start at|Duration|stderr \||stdout \|)/;
const TEST_PATH_LINE = /\b[\w./-]+\.test\.tsx?\b/;
const scannable = (stdout + '\n' + stderr)
  .split('\n')
  .map((line) => line.replace(ANSI, ''))
  .filter((line) => !REPORTER_LINE.test(line) && !TEST_PATH_LINE.test(line))
  .join('\n');

// Heuristic indicators. If a test emits these via console.warn the wrapper
// fails even if the assertion library swallowed them.
const indicators = [
  /\bleak\b/i,
  /detached dom/i,
  /listener.*not removed/i,
  /react root.*not unmounted/i,
  /dnd-?kit.*context.*active/i,
];

const hits = indicators.flatMap((re) => {
  const m = scannable.match(new RegExp(re.source, re.flags + 'g'));
  return m ? [{ pattern: re.source, count: m.length }] : [];
});

if (hits.length) {
  console.error('checkLeaks: leak indicators detected:', hits);
  process.exit(1);
}

process.exit(res.status ?? 0);

#!/usr/bin/env node
/**
 * bench.mjs
 *
 * Cold-open benchmark for a 1000-card board.
 *
 * Pipeline:
 *   1. Generate fixture (idempotent) if absent.
 *   2. Bundle the parser entrypoint via esbuild → a tmp ESM file we can
 *      import from Node. The src tree is TypeScript so a raw Node import
 *      can't read it; esbuild gives us a portable artifact.
 *   3. Warmup the parser (3 runs) then sample (10 runs). Report the median
 *      and p95 — never the mean, since GC tail latency matters for cold-open.
 *   4. Write `bench-results.json`. Compare against `bench-budgets.json`.
 *      Exit non-zero on regression — the CI gate is HARD as of post-Alpha
 *      (see .github/workflows/ci.yml).
 *
 * Usage:
 *   node scripts/bench.mjs              # desktop budget
 *   node scripts/bench.mjs --mobile     # mobile budget (still local Node;
 *                                         the mobile gate is a proxy until
 *                                         we wire device CI)
 *
 * Exit codes:
 *   0 — pass
 *   1 — budget regression or unexpected error
 *   2 — parser returned errors on the fixture (degraded build)
 *   3 — parser module not found at the expected path
 */
import { readFile, writeFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = resolve(REPO_ROOT, 'src/__tests__/fixtures/big.md');
const BUDGETS = resolve(REPO_ROOT, 'scripts/bench-budgets.json');
const RESULTS = resolve(REPO_ROOT, 'bench-results.json');
const PARSER_ENTRY = resolve(REPO_ROOT, 'src/core/parser/index.ts');

const isMobile = process.argv.includes('--mobile');

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

async function ensureFixture() {
  if (existsSync(FIXTURE)) return;
  await mkdir(dirname(FIXTURE), { recursive: true });
  const gen = resolve(__dirname, 'generateFixture.mjs');
  const res = spawnSync(process.execPath, [gen], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('generateFixture failed');
}

/**
 * Build a portable CJS bundle of the parser to a temp file we can require
 * from this Node process. We bundle so transitive CJS deps (e.g. `yaml`)
 * come along; ESM bundling trips over their `require("process")` shims.
 * Returns the absolute path to the bundle.
 */
async function bundleParser() {
  if (!existsSync(PARSER_ENTRY)) return null;
  const tmpRoot = await mkdtemp(join(tmpdir(), 'kanban-bench-'));
  const outfile = join(tmpRoot, 'parser.cjs');
  await esbuild.build({
    entryPoints: [PARSER_ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    external: ['obsidian'],
    alias: { '@': resolve(REPO_ROOT, 'src') },
  });
  return outfile;
}

async function main() {
  await ensureFixture();

  const bundle = await bundleParser();
  if (!bundle) {
    console.error(`bench: parser entry not found at ${PARSER_ENTRY}`);
    process.exit(3);
  }

  let parseBoard;
  try {
    const require = createRequire(import.meta.url);
    const mod = require(bundle);
    parseBoard = mod.parseBoard ?? mod.default?.parseBoard;
  } catch (err) {
    console.error('bench: failed to load bundled parser:', err);
    process.exit(1);
  }
  if (typeof parseBoard !== 'function') {
    console.error('bench: bundled parser does not export parseBoard');
    process.exit(3);
  }

  const source = await readFile(FIXTURE, 'utf8');
  const fixtureStat = await stat(FIXTURE);

  // Sanity-probe before timing: if the parser is degraded and returns
  // errors on the canonical fixture, exit 2 — there is no useful number
  // to report.
  const probe = parseBoard(source);
  if (!probe || (probe.board == null && probe.errors?.length)) {
    console.error('bench: parser returned errors on fixture:', probe?.errors?.slice(0, 3));
    process.exit(2);
  }

  // Warmup
  for (let i = 0; i < 3; i++) parseBoard(source);

  const samples = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const result = parseBoard(source);
    const t1 = performance.now();
    if (!result || (result.board == null && result.errors?.length)) {
      console.error('bench: parser regressed mid-run:', result?.errors?.slice(0, 3));
      process.exit(2);
    }
    samples.push(t1 - t0);
  }

  const med = median(samples);
  const high = p95(samples);
  const budgets = JSON.parse(await readFile(BUDGETS, 'utf8'));
  const budget = isMobile
    ? budgets.coldOpen1000Cards.mobile.maxMs
    : budgets.coldOpen1000Cards.desktop.maxMs;

  const passed = high <= budget;
  const out = {
    timestamp: new Date().toISOString(),
    target: isMobile ? 'mobile' : 'desktop',
    fixture: { path: FIXTURE, bytes: fixtureStat.size },
    samples,
    medianMs: med,
    p95Ms: high,
    budgetMs: budget,
    passed,
  };

  await writeFile(RESULTS, JSON.stringify(out, null, 2), 'utf8');
  console.log(
    `bench: ${out.target} median=${med.toFixed(2)}ms p95=${high.toFixed(2)}ms budget=${budget}ms → ${passed ? 'PASS' : 'FAIL'}`,
  );

  // Clean up the temp bundle dir (best-effort; non-fatal if it fails).
  try {
    await rm(dirname(bundle), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // HARD GATE: regression fails CI. This is the post-Alpha policy. The
  // previous "continue-on-error" wrapper in .github/workflows/ci.yml has
  // been removed.
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error('bench: error:', err);
  process.exit(1);
});

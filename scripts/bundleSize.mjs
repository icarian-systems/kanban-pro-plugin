#!/usr/bin/env node
/**
 * bundleSize.mjs
 *
 * Gzips main.js and fails if it exceeds the architectural budget:
 *   - free core: ≤ 350KB gz
 *   - pro     : ≤ 250KB gz (invoke with --pro)
 *
 * Skips cleanly with a clear message if main.js doesn't exist (CI may run
 * this before the build step is hooked up).
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUDGETS = resolve(REPO_ROOT, 'scripts/bench-budgets.json');
const MAIN_JS = resolve(REPO_ROOT, 'main.js');

const isPro = process.argv.includes('--pro');

async function main() {
  if (!existsSync(MAIN_JS)) {
    console.log('bundleSize: skipped: main.js not built. Run `pnpm build` first.');
    process.exit(0);
  }

  const budgets = JSON.parse(await readFile(BUDGETS, 'utf8'));
  const limitKB = isPro ? budgets.bundleSizeGz.proKB : budgets.bundleSizeGz.freeKB;
  const limitBytes = limitKB * 1024;

  const src = await readFile(MAIN_JS);
  const gz = gzipSync(src, { level: 9 });
  const rawKB = (src.byteLength / 1024).toFixed(1);
  const gzKB = (gz.byteLength / 1024).toFixed(1);
  const fs = await stat(MAIN_JS);

  const tier = isPro ? 'pro' : 'free';
  const passed = gz.byteLength <= limitBytes;
  console.log(
    `bundleSize: ${tier} raw=${rawKB}KB gz=${gzKB}KB budget=${limitKB}KB → ${passed ? 'PASS' : 'FAIL'} (mtime ${new Date(fs.mtimeMs).toISOString()})`,
  );
  if (!passed) {
    console.error(
      `bundleSize: regression: ${gzKB}KB gz exceeds ${limitKB}KB ${tier} budget by ${(gz.byteLength - limitBytes) / 1024} KB.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('bundleSize: error:', err);
  process.exit(1);
});

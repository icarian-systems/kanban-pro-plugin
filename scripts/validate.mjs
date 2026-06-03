#!/usr/bin/env node
/**
 * scripts/validate.mjs
 *
 * Usage:
 *   node scripts/validate.mjs path/to/board.md [more.md ...]
 *
 * Reports, per file:
 *   - parse errors (if any) with severity and byte position
 *   - whether the round-trip is byte-identical
 *   - a per-line diff for the first N changed lines if it isn't
 *
 * This script is the engine behind:
 *   - the `Kanban: Validate board` command (Free tier)
 *   - the 2-week-pre-1.0 validator rollout that scans every board
 *     in a user's vault before they upgrade
 *
 * It is pure Node — no Obsidian dependency. The parser source is
 * TypeScript, so at startup we bundle `src/core/parser/index.ts` to a
 * temp CJS file via esbuild (mirroring `scripts/bench.mjs`) and then
 * require it. We bundle to CJS so transitive CJS deps (e.g. `yaml`)
 * come along cleanly; ESM bundling trips over their `require("process")`
 * shims.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PARSER_ENTRY = resolve(REPO_ROOT, 'src/core/parser/index.ts');

const COLOR = process.stdout.isTTY ? {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
} : { red: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s, dim: (s) => s };

/**
 * Build a portable CJS bundle of the parser to a temp file we can require
 * from this Node process. Returns the absolute path to the bundle, or
 * `null` if the parser entry is missing.
 */
async function bundleParser() {
  if (!existsSync(PARSER_ENTRY)) return null;
  const tmpRoot = await mkdtemp(join(tmpdir(), 'kanban-validate-'));
  const outfile = join(tmpRoot, 'parser.cjs');
  await esbuild.build({
    entryPoints: [PARSER_ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent',
    external: ['obsidian'],
    alias: { '@': resolve(REPO_ROOT, 'src') },
  });
  return outfile;
}

function reportFile(path, parseBoard, serializeBoard) {
  const abs = resolve(path);
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch (e) {
    console.error(COLOR.red(`read failed: ${abs} — ${e.message}`));
    return 2;
  }

  const { board, errors } = parseBoard(src);
  console.log(COLOR.bold(`\n• ${abs}`));

  for (const err of errors) {
    const tag = err.severity === 'error' ? COLOR.red('error') : COLOR.yellow('warn ');
    const pos = err.position ? COLOR.dim(`@${err.position.start}..${err.position.end}`) : '';
    console.log(`  ${tag} ${err.message} ${pos}`);
  }

  if (!board) {
    console.log(COLOR.red('  parse failed — no board produced'));
    return 1;
  }

  const out = serializeBoard(board, src);
  if (out === src) {
    console.log(COLOR.green(`  round-trip: byte-identical (${src.length} bytes)`));
    return errors.some((e) => e.severity === 'error') ? 1 : 0;
  }

  console.log(COLOR.yellow(`  round-trip: BYTE DIFF (in ${src.length} -> out ${out.length})`));
  const diffs = lineDiff(src, out, 10);
  for (const d of diffs) console.log(`    ${d}`);
  return 1;
}

function lineDiff(a, b, max) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  const out = [];
  let shown = 0;
  for (let i = 0; i < n; i++) {
    if (al[i] === bl[i]) continue;
    if (shown >= max) {
      out.push(COLOR.dim(`...and ${n - i} more lines`));
      break;
    }
    out.push(`L${i + 1}: ${COLOR.red('- ' + JSON.stringify(al[i] ?? ''))}`);
    out.push(`     ${COLOR.green('+ ' + JSON.stringify(bl[i] ?? ''))}`);
    shown += 1;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/validate.mjs <board.md> [...more.md]');
    process.exit(2);
  }

  const bundle = await bundleParser();
  if (!bundle) {
    console.error(COLOR.red(`validate: parser entry not found at ${PARSER_ENTRY}`));
    process.exit(3);
  }

  let parseBoard;
  let serializeBoard;
  try {
    const require = createRequire(import.meta.url);
    const mod = require(bundle);
    parseBoard = mod.parseBoard ?? mod.default?.parseBoard;
    serializeBoard = mod.serializeBoard ?? mod.default?.serializeBoard;
  } catch (err) {
    console.error(COLOR.red('validate: failed to load bundled parser:'), err);
    process.exit(1);
  }
  if (typeof parseBoard !== 'function' || typeof serializeBoard !== 'function') {
    console.error(
      COLOR.red('validate: bundled parser does not export parseBoard/serializeBoard'),
    );
    process.exit(3);
  }

  let code = 0;
  for (const p of args) {
    const r = reportFile(p, parseBoard, serializeBoard);
    if (r !== 0) code = r;
  }

  // Best-effort cleanup of the temp bundle dir.
  try {
    await rm(dirname(bundle), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(code);
}

main().catch((err) => {
  console.error(COLOR.red('validate: error:'), err);
  process.exit(1);
});

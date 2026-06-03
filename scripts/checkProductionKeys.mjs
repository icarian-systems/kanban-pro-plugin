#!/usr/bin/env node
/**
 * checkProductionKeys.mjs
 *
 * CI guard that protects the released bundle from shipping with a
 * placeholder (non-production) public key in any `PUBLIC_KEYS` slot inside
 * `src/pro/license/keys.ts`.
 *
 * Why: license tokens only verify if `PUBLIC_KEYS` holds the real
 * production keys. A build that ships with the default all-zero placeholder
 * — or a local development key accidentally committed — would verify
 * nothing and break activation for every user, so this guard fails the
 * release build whenever such a key is present, whether pasted in literally
 * or referenced via a named constant.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const KEYS_PATH = resolve(REPO_ROOT, 'src/pro/license/keys.ts');

const source = readFileSync(KEYS_PATH, 'utf8');
const ZERO_HEX = '0'.repeat(64);
// Public half of the well-known local development signing key. It is not a
// production key, so treat it as a placeholder: the guard fails fast if it
// ever slips into a tagged release. Same code path as ZERO_HEX — single
// message, single exit code, no special-casing.
const DEV_KEY_HEX = 'dc3169669e1dea0e8bf88c8335003c7d875ed8aee6fa7305570778fb4afb02ee';
const PLACEHOLDER_HEXES = new Set([ZERO_HEX, DEV_KEY_HEX]);

// Build a map of `const NAME = '<hex>'` so we can resolve referenced
// constants in PUBLIC_KEYS entries. Only top-level string literal
// `const`/`let` are considered — anything more dynamic is out of scope.
const constMap = new Map();
const constRe = /(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"]([0-9a-fA-F]{64})['"]/gi;
let cm;
while ((cm = constRe.exec(source)) !== null) {
  constMap.set(cm[1], cm[2].toLowerCase());
}

// Match `publicKeyHex:` followed by either a string literal or an
// identifier. We accept whitespace and the field separator that comes
// before the closing brace/comma.
const entryRe = /publicKeyHex\s*:\s*(?:['"]([0-9a-fA-F]{64})['"]|([A-Za-z_$][A-Za-z0-9_$]*))/g;
const offenders = [];
let m;
while ((m = entryRe.exec(source)) !== null) {
  const literal = m[1];
  const ident = m[2];
  let hex = null;
  if (literal) {
    hex = literal.toLowerCase();
  } else if (ident && constMap.has(ident)) {
    hex = constMap.get(ident);
  }
  if (hex !== null && PLACEHOLDER_HEXES.has(hex)) {
    offenders.push(ident ?? literal);
  }
}

const strict = process.argv.includes('--strict') || process.env.KANBAN_RELEASE === '1';

if (offenders.length > 0) {
  const head = `[checkProductionKeys] ${strict ? 'FAIL' : 'WARN'} — ${offenders.length} PUBLIC_KEYS entry/entries in src/pro/license/keys.ts still hold a known placeholder (all-zero or dev-only) public key.`;
  const tail = [
    '  Paste the real production public keys into PUBLIC_KEYS before tagging a release.',
    strict
      ? '  (--strict / KANBAN_RELEASE=1 is set — this is a release gate; failing the build.)'
      : '  (Re-run with --strict or KANBAN_RELEASE=1 to fail the build — used by the release workflow.)',
  ].join('\n');
  if (strict) {
    console.error(`\n${head}\n${tail}`);
    process.exit(1);
  }
  console.warn(`\n${head}\n${tail}`);
  process.exit(0);
}

console.log('[checkProductionKeys] OK — no placeholder (all-zero or dev) public keys in src/pro/license/keys.ts.');
process.exit(0);

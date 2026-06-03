/**
 * Inline-metadata tokenizer.
 *
 * Grammar: see `docs/inline-meta.ebnf` (EBNF spec).
 *
 * The tokenizer is greedy and left-to-right; it never mutates the
 * card text. It returns:
 *   - `meta`   the structured InlineMeta record for the model.
 *   - `tokens` the *original token order* with byte offsets relative
 *              to the input string, so a write-back layer that wants
 *              to preserve order on a mutated card can do so.
 *
 * The tokenizer is pure: it does not depend on remark or obsidian.
 */
import type { InlineMeta } from '@/core/model';

/* -------------------------------------------------------------- */
/* Token kinds and Tasks-plugin emoji table                       */
/* -------------------------------------------------------------- */

export type InlineTokenKind =
  | 'date' // @{YYYY-MM-DD}
  | 'time' // @@{HH:mm}
  | 'tag' // #tag
  | 'blockId' // ^blockid
  | 'field' // [k:: v]
  | 'emoji'; // 📅 2026-01-01 etc.

export interface InlineToken {
  kind: InlineTokenKind;
  start: number;
  end: number;
  /** Raw source slice `[start..end)`. */
  raw: string;
  /**
   * Token-kind-specific data. For 'emoji', `key` is the canonical
   * emoji string and `value` is whatever followed it (or '' for
   * priority emoji, which take no argument).
   */
  key?: string;
  value?: string;
}

export interface InlineTokenizeResult {
  meta: InlineMeta;
  tokens: InlineToken[];
}

/** Tasks-plugin emoji set, with their semantic key in `meta.emoji`. */
const EMOJI_TABLE: Record<string, { keyName: string; takesArg: 'date' | 'text' | 'none' }> = {
  '📅': { keyName: 'due', takesArg: 'date' },
  '⏳': { keyName: 'scheduled', takesArg: 'date' },
  '🛫': { keyName: 'start', takesArg: 'date' },
  '✅': { keyName: 'done', takesArg: 'date' },
  '❌': { keyName: 'cancelled', takesArg: 'date' },
  '➕': { keyName: 'created', takesArg: 'date' },
  '🔁': { keyName: 'recurrence', takesArg: 'text' },
  '🆔': { keyName: 'taskId', takesArg: 'text' },
  '🏁': { keyName: 'onCompletion', takesArg: 'text' },
  '🔺': { keyName: 'priority', takesArg: 'none' }, // priority=highest
  '⏫': { keyName: 'priority', takesArg: 'none' }, // priority=high
  '🔼': { keyName: 'priority', takesArg: 'none' }, // priority=medium
  '🔽': { keyName: 'priority', takesArg: 'none' }, // priority=low
  '🔻': { keyName: 'priority', takesArg: 'none' }, // priority=lowest
};

const PRIORITY_VALUE: Record<string, string> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '🔻': 'lowest',
};

/** Longest-first list of emoji triggers for prefix-matching. */
const EMOJI_TRIGGERS: string[] = Object.keys(EMOJI_TABLE).sort((a, b) => b.length - a.length);

/* -------------------------------------------------------------- */
/* Character-class predicates                                     */
/* -------------------------------------------------------------- */

const DIGIT_RE = /[0-9]/;
const TAG_CHAR_RE = /[\p{L}\p{N}_/\-]/u;
const BLOCKID_CHAR_RE = /[A-Za-z0-9-]/;
const KEY_CHAR_RE = /[A-Za-z0-9_\- ]/;

function isDigit(ch: string): boolean {
  return ch.length === 1 && DIGIT_RE.test(ch);
}
function isTagChar(ch: string): boolean {
  return ch.length > 0 && TAG_CHAR_RE.test(ch);
}
function isBlockIdChar(ch: string): boolean {
  return ch.length === 1 && BLOCKID_CHAR_RE.test(ch);
}
function isKeyChar(ch: string): boolean {
  return ch.length === 1 && KEY_CHAR_RE.test(ch);
}

/* -------------------------------------------------------------- */
/* Public entry point                                             */
/* -------------------------------------------------------------- */

export function emptyMeta(): InlineMeta {
  return { tags: [], fields: {}, emoji: {} };
}

/**
 * Return `text` with every recognised inline-meta token removed (and any
 * single whitespace character immediately preceding each token collapsed
 * out). Used by Card title rendering so the chip-rendering surfaces don't
 * also have to fight the raw token strings.
 *
 * Works token-precise off `parseInlineMeta` offsets — no regex
 * round-tripping that could de-sync from the parser's vocabulary as
 * tokens are added.
 */
export function stripInlineMetaTokens(text: string): string {
  const { tokens } = parseInlineMeta(text);
  if (tokens.length === 0) return text;
  let out = text;
  // Iterate right-to-left so byte offsets stay valid as we splice.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const leadingSpace =
      t.start > 0 && out.charCodeAt(t.start - 1) === 0x20 ? 1 : 0;
    out = out.slice(0, t.start - leadingSpace) + out.slice(t.end);
  }
  return out.replace(/[ \t]+(\r?\n|$)/g, '$1').trim();
}

export function parseInlineMeta(text: string): InlineTokenizeResult {
  const meta: InlineMeta = emptyMeta();
  const tokens: InlineToken[] = [];

  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // @{YYYY-MM-DD}  or  @@{HH:mm}
    if (ch === '@') {
      const t = tryDate(text, i) ?? tryTime(text, i);
      if (t) {
        applyToken(meta, t);
        tokens.push(t);
        i = t.end;
        continue;
      }
    }

    // #tag
    if (ch === '#') {
      const t = tryTag(text, i);
      if (t) {
        applyToken(meta, t);
        tokens.push(t);
        i = t.end;
        continue;
      }
    }

    // ^blockid (only at end-of-string or before whitespace/newline)
    if (ch === '^') {
      const t = tryBlockId(text, i);
      if (t) {
        applyToken(meta, t);
        tokens.push(t);
        i = t.end;
        continue;
      }
    }

    // [key:: value]
    if (ch === '[') {
      const t = tryField(text, i);
      if (t) {
        applyToken(meta, t);
        tokens.push(t);
        i = t.end;
        continue;
      }
    }

    // Emoji (multi-byte trigger)
    const emo = tryEmoji(text, i);
    if (emo) {
      applyToken(meta, emo);
      tokens.push(emo);
      i = emo.end;
      continue;
    }

    i += 1;
  }

  return { meta, tokens };
}

/* -------------------------------------------------------------- */
/* Per-token parsers                                              */
/* -------------------------------------------------------------- */

function tryDate(s: string, at: number): InlineToken | null {
  // @{YYYY-MM-DD}
  if (s[at] !== '@' || s[at + 1] !== '{') return null;
  // length: '@{' + 10 + '}' = 13
  if (at + 13 > s.length) return null;
  if (s[at + 12] !== '}') return null;
  const iso = s.slice(at + 2, at + 12);
  if (!isIsoDate(iso)) return null;
  return {
    kind: 'date',
    start: at,
    end: at + 13,
    raw: s.slice(at, at + 13),
    value: iso,
  };
}

function tryTime(s: string, at: number): InlineToken | null {
  // @@{HH:mm}
  if (s[at] !== '@' || s[at + 1] !== '@' || s[at + 2] !== '{') return null;
  // length: '@@{' + 5 + '}' = 9
  if (at + 9 > s.length) return null;
  if (s[at + 8] !== '}') return null;
  const hhmm = s.slice(at + 3, at + 8);
  if (!isHourMinute(hhmm)) return null;
  return {
    kind: 'time',
    start: at,
    end: at + 9,
    raw: s.slice(at, at + 9),
    value: hhmm,
  };
}

function tryTag(s: string, at: number): InlineToken | null {
  if (s[at] !== '#') return null;
  let j = at + 1;
  let sawNonDigit = false;
  while (j < s.length && isTagChar(s[j])) {
    if (!isDigit(s[j])) sawNonDigit = true;
    j += 1;
  }
  if (j === at + 1) return null; // empty tag
  if (!sawNonDigit) return null; // all digits => not a tag
  const body = s.slice(at + 1, j);
  return {
    kind: 'tag',
    start: at,
    end: j,
    raw: s.slice(at, j),
    value: body,
  };
}

function tryBlockId(s: string, at: number): InlineToken | null {
  if (s[at] !== '^') return null;
  let j = at + 1;
  while (j < s.length && isBlockIdChar(s[j])) j += 1;
  if (j === at + 1) return null;
  // Block IDs are only legal at end-of-line / end-of-input.
  if (j < s.length && s[j] !== '\n' && s[j] !== '\r' && s[j] !== ' ' && s[j] !== '\t') {
    return null;
  }
  const body = s.slice(at + 1, j);
  return {
    kind: 'blockId',
    start: at,
    end: j,
    raw: s.slice(at, j),
    value: body,
  };
}

function tryField(s: string, at: number): InlineToken | null {
  // [key:: value]
  if (s[at] !== '[') return null;
  // find key
  let j = at + 1;
  while (j < s.length && isKeyChar(s[j])) j += 1;
  if (j === at + 1) return null;
  if (s[j] !== ':' || s[j + 1] !== ':') return null;
  const keyStart = at + 1;
  const keyEnd = j;
  // skip '::'
  let k = j + 2;
  // optional single-space pad (Dataview convention)
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k += 1;
  // value runs to ']' on same line
  const valStart = k;
  while (k < s.length && s[k] !== ']' && s[k] !== '\n' && s[k] !== '\r') k += 1;
  if (k >= s.length || s[k] !== ']') return null;
  const key = s.slice(keyStart, keyEnd).trim();
  if (!key) return null;
  const value = s.slice(valStart, k);
  return {
    kind: 'field',
    start: at,
    end: k + 1,
    raw: s.slice(at, k + 1),
    key,
    value,
  };
}

function tryEmoji(s: string, at: number): InlineToken | null {
  // Match longest emoji trigger first.
  let trigger: string | null = null;
  for (const t of EMOJI_TRIGGERS) {
    if (s.startsWith(t, at)) {
      trigger = t;
      break;
    }
  }
  if (!trigger) return null;

  const def = EMOJI_TABLE[trigger];
  const triggerEnd = at + trigger.length;

  if (def.takesArg === 'none') {
    // Priority emoji — no argument.
    return {
      kind: 'emoji',
      start: at,
      end: triggerEnd,
      raw: trigger,
      key: def.keyName,
      value: PRIORITY_VALUE[trigger] ?? '',
    };
  }

  // Skip whitespace, then read argument.
  let j = triggerEnd;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j += 1;

  if (def.takesArg === 'date') {
    if (j + 10 > s.length) return null;
    const iso = s.slice(j, j + 10);
    if (!isIsoDate(iso)) return null;
    return {
      kind: 'emoji',
      start: at,
      end: j + 10,
      raw: s.slice(at, j + 10),
      key: def.keyName,
      value: iso,
    };
  }

  // 'text' arg — read up to next whitespace or end-of-line. For
  // recurrence we want the rest of the line, so use newline as the
  // delimiter; for taskId / onCompletion any whitespace ends the arg.
  let k = j;
  if (def.keyName === 'recurrence') {
    while (k < s.length && s[k] !== '\n' && s[k] !== '\r') k += 1;
  } else {
    while (k < s.length && s[k] !== ' ' && s[k] !== '\t' && s[k] !== '\n' && s[k] !== '\r') {
      k += 1;
    }
  }
  if (k === j) return null;
  const value = s.slice(j, k).trimEnd();
  return {
    kind: 'emoji',
    start: at,
    end: k,
    raw: s.slice(at, k),
    key: def.keyName,
    value,
  };
}

/* -------------------------------------------------------------- */
/* Validators                                                     */
/* -------------------------------------------------------------- */

function isIsoDate(s: string): boolean {
  if (s.length !== 10) return false;
  if (s[4] !== '-' || s[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    if (!isDigit(s[i])) return false;
  }
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  return true;
}

function isHourMinute(s: string): boolean {
  if (s.length !== 5) return false;
  if (s[2] !== ':') return false;
  if (!isDigit(s[0]) || !isDigit(s[1]) || !isDigit(s[3]) || !isDigit(s[4])) return false;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(3, 5));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/* -------------------------------------------------------------- */
/* Apply a token to the InlineMeta accumulator                    */
/* -------------------------------------------------------------- */

function applyToken(meta: InlineMeta, t: InlineToken): void {
  switch (t.kind) {
    case 'date':
      // First @{date} wins; subsequent ones are kept as tokens but
      // not overwritten on the struct so write-back can keep them
      // verbatim by position.
      if (meta.date === undefined) meta.date = t.value;
      return;
    case 'time':
      if (meta.time === undefined) meta.time = t.value;
      return;
    case 'tag':
      if (t.value && !meta.tags.includes(t.value)) meta.tags.push(t.value);
      return;
    case 'blockId':
      meta.blockId = t.value;
      return;
    case 'field':
      if (t.key !== undefined) meta.fields[t.key] = t.value ?? '';
      return;
    case 'emoji':
      if (t.key !== undefined) meta.emoji[t.key] = t.value ?? '';
      return;
  }
}

/* -------------------------------------------------------------- */
/* Token write-back helpers                                       */
/* -------------------------------------------------------------- */

/**
 * Return `text` with all existing `#tag` tokens removed and the supplied
 * `tags` list appended as space-separated `#tag` tokens. Used by the
 * DetailPanel when the user edits the Tags field — the inline tokens are
 * the source of truth on disk (for file-format compatibility), so a
 * meta-only patch would be lost on save.
 *
 * The helper deliberately canonicalises tag layout (existing tokens are
 * dropped and the new list is appended at the end). Cards whose text was
 * unchanged still benefit from the diff/patch byte-identity guarantee in
 * `serializeBoard` because we only rewrite the text when tags actually
 * differ — see the caller for the equality short-circuit.
 */
export function setTagsInText(text: string, tags: readonly string[]): string {
  const { tokens } = parseInlineMeta(text);

  // Strip every 'tag' token, working from right to left so byte offsets
  // stay valid.
  let stripped = text;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind !== 'tag') continue;
    // Also consume one immediately-preceding ASCII space so removing
    // `#urgent` from "foo #urgent" leaves "foo", not "foo ".
    const leadingSpace =
      t.start > 0 && stripped.charCodeAt(t.start - 1) === 0x20 ? 1 : 0;
    stripped = stripped.slice(0, t.start - leadingSpace) + stripped.slice(t.end);
  }

  // Trim trailing whitespace on each line (without touching newlines or
  // indentation) so we don't leave dangling spaces where tags used to be.
  stripped = stripped.replace(/[ \t]+(\r?\n|$)/g, '$1');

  const cleanTags = tags
    .map((t) => t.replace(/^#+/, '').trim())
    .filter((t) => t.length > 0);

  if (cleanTags.length === 0) return stripped;

  const suffix = cleanTags.map((t) => `#${t}`).join(' ');
  // Join with a single space, unless `stripped` is empty or ends with
  // whitespace.
  if (stripped.length === 0) return suffix;
  if (/\s$/.test(stripped)) return stripped + suffix;
  return stripped + ' ' + suffix;
}

/**
 * Return `text` with every existing `[key:: value]` field token rewritten to
 * the supplied `fields` record. Tokens that survive get their values updated
 * in-place (so token order is preserved); fields not present in the existing
 * text are appended at the end as `[key:: value]`. Fields present in the text
 * but absent from the new record are removed.
 *
 * The DetailPanel commits assignee/repeat edits as
 * `meta.fields.assignee` updates while `card.text` is untouched. Without this
 * synchroniser, `canonicalCard` (which re-serializes from `card.text`)
 * silently dropped the edited assignee on the next write — the exact data
 * loss this synchroniser prevents.
 *
 * Symmetric with `setTagsInText`: it never mutates input, walks tokens
 * right-to-left for offset stability, and trims dangling whitespace.
 */
export function setFieldsInText(
  text: string,
  fields: Readonly<Record<string, string>>,
): string {
  const { tokens } = parseInlineMeta(text);

  // 1. Update / strip existing field tokens. Right-to-left for offset
  //    stability. Keys consumed here are removed from `remaining` so the
  //    appender below only emits *new* fields.
  const remaining: Record<string, string> = { ...fields };
  let stripped = text;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind !== 'field' || t.key === undefined) continue;
    const key = t.key;
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      // Update in place, preserving Dataview's `[k:: v]` form.
      const replacement = `[${key}:: ${remaining[key]}]`;
      stripped =
        stripped.slice(0, t.start) + replacement + stripped.slice(t.end);
      delete remaining[key];
    } else {
      // Field gone from the model — strip the token and its leading space.
      const leadingSpace =
        t.start > 0 && stripped.charCodeAt(t.start - 1) === 0x20 ? 1 : 0;
      stripped =
        stripped.slice(0, t.start - leadingSpace) + stripped.slice(t.end);
    }
  }

  // 2. Trim trailing whitespace on each line (mirrors setTagsInText).
  stripped = stripped.replace(/[ \t]+(\r?\n|$)/g, '$1');

  // 3. Append any new fields.
  const newKeys = Object.keys(remaining);
  if (newKeys.length === 0) return stripped;
  const suffix = newKeys
    .map((k) => `[${k}:: ${remaining[k]}]`)
    .join(' ');
  if (stripped.length === 0) return suffix;
  if (/\s$/.test(stripped)) return stripped + suffix;
  return stripped + ' ' + suffix;
}

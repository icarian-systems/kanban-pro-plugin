/**
 * Sentinel pre-pass.
 *
 * Before handing the source to remark, we locate and "extract" the
 * load-bearing structural tokens that remark would otherwise normalise
 * away or mis-classify:
 *
 *   1. `***` thematic break that introduces the archive section.
 *      remark *does* round-trip this, but we record its offset so the
 *      writer can be certain about archive placement.
 *   2. `## Archive` heading (the literal title is recognised by
 *      meaning, not by remark — we mark it as archive-kind here).
 *   3. `**Complete**` lane marker line — same idea: remark sees a
 *      bold-text paragraph but we want to know which lane it tags.
 *   4. `%% kanban:settings %%` block — comment-style sentinel that
 *      wraps a fenced JSON code block. remark *does not* see the
 *      `%% ... %%` markers as anything structural (they're a custom
 *      Obsidian convention), so we extract the whole settings block
 *      out-of-band before invoking remark, then restore the byte
 *      offset for the writer.
 *
 * This module is pure-Node and depends on no remark internals.
 * It is intentionally conservative: a sentinel is only "found" if
 * it appears in canonical form at the start of a line (after the
 * frontmatter, if any).
 */

export interface SentinelMatch {
  /** Byte offset where the sentinel starts (line-start). */
  start: number;
  /** Byte offset of the first char *after* the sentinel block. */
  end: number;
  /** Verbatim source of the sentinel block. */
  raw: string;
}

export interface SettingsSentinel extends SentinelMatch {
  /** The JSON body inside the fenced block (raw text). */
  json: string;
  /** Offsets of the JSON body inside the source. */
  jsonStart: number;
  jsonEnd: number;
  /**
   * Which on-disk form the parser matched:
   *   - `modern`: `%% kanban:settings\n` (multi-line comment).
   *   - `legacy-inline-closer`: `%% kanban:settings %%` (inline closer +
   *     visible fenced block). The visible fence is a symptom — the
   *     writer must NOT reuse the raw block for this form;
   *     re-rendering migrates it to canonical on the next mutation.
   */
  format: 'modern' | 'legacy-inline-closer';
}

export interface Sentinels {
  /** First `***` thematic break that begins an archive section. */
  archiveBreak: SentinelMatch | null;
  /** `## Archive` heading offset, if present after archiveBreak. */
  archiveHeading: SentinelMatch | null;
  /** Each `**Complete**` line found in the body (by offset). */
  completeMarkers: SentinelMatch[];
  /** The single `%% kanban:settings %%` block, if any. */
  settings: SettingsSentinel | null;
  /** Frontmatter span (the `--- ... ---` block at top), if any. */
  frontmatter: SentinelMatch | null;
}

/* -------------------------------------------------------------- */
/* Public entry                                                   */
/* -------------------------------------------------------------- */

export function findSentinels(source: string): Sentinels {
  const fm = findFrontmatter(source);
  const bodyStart = fm ? fm.end : 0;

  return {
    frontmatter: fm,
    settings: findSettings(source, bodyStart),
    archiveBreak: findArchiveBreak(source, bodyStart),
    archiveHeading: findArchiveHeading(source, bodyStart),
    completeMarkers: findCompleteMarkers(source, bodyStart),
  };
}

/* -------------------------------------------------------------- */
/* Frontmatter                                                    */
/* -------------------------------------------------------------- */

/**
 * Detect a YAML frontmatter block at offset 0 (after BOM). Returns
 * the byte range including the closing `---` line and its newline.
 */
export function findFrontmatter(source: string): SentinelMatch | null {
  let off = 0;
  if (source.charCodeAt(0) === 0xfeff) off = 1; // BOM
  if (!source.startsWith('---', off)) return null;
  // must be at line-start; verify char after is newline
  const afterOpen = off + 3;
  if (source[afterOpen] !== '\n' && source[afterOpen] !== '\r') return null;
  // search for closing '---' on its own line
  let i = afterOpen;
  while (i < source.length) {
    // advance to next line start
    const nl = source.indexOf('\n', i);
    if (nl === -1) return null;
    const lineStart = nl + 1;
    if (
      source.startsWith('---', lineStart) &&
      (source[lineStart + 3] === '\n' ||
        source[lineStart + 3] === '\r' ||
        lineStart + 3 === source.length)
    ) {
      // consume the closing '---' and its trailing newline
      let end = lineStart + 3;
      if (source[end] === '\r') end += 1;
      if (source[end] === '\n') end += 1;
      return { start: off, end, raw: source.slice(off, end) };
    }
    i = lineStart;
  }
  return null;
}

/* -------------------------------------------------------------- */
/* Settings block — two on-disk forms, both accepted:              */
/*                                                                 */
/*   (legacy, mgmeyers v1.4-)            (current, single comment) */
/*   %% kanban:settings %%               %% kanban:settings        */
/*   ```                                 ```                       */
/*   { ...json... }                      { ...json... }            */
/*   ```                                 ```                       */
/*   %%                                  %%                        */
/*                                                                 */
/* The legacy form was a self-closed Obsidian comment + a fenced   */
/* code block + a stray `%%` closer; the fenced JSON rendered as a */
/* *visible* code block in source mode. The current form wraps the */
/* whole thing in a single multi-line `%% ... %%` comment so the   */
/* JSON stays hidden. Both must parse; the writer emits the        */
/* current form (renderSettingsBlock).                             */
/* -------------------------------------------------------------- */

// `\s*` consumes the newline between `kanban:settings` and the
// optional inline `%%` closer — so the same regex matches both
// `%% kanban:settings %%` and `%% kanban:settings` followed by a
// fenced block. The trailing `(?:%%)?` is captured so we can
// distinguish the two on-disk forms.
const SETTINGS_OPEN_RE = /%%\s*kanban:settings\b[ \t]*(%%)?/;

export function findSettings(source: string, from = 0): SettingsSentinel | null {
  const m = SETTINGS_OPEN_RE.exec(source.slice(from));
  if (!m) return null;
  const openStart = from + m.index;
  // The sentinel opens at line-start (or top-of-body); back up to line start.
  const lineStart = findLineStart(source, openStart);
  // Inline `%%` immediately after `kanban:settings` on the
  // same line is the legacy form (mgmeyers v1.4-). The current form has no
  // inline closer — the whole block is wrapped in a single multi-line
  // comment. We detect the legacy form here so write.ts can refuse to reuse
  // its raw bytes (which would otherwise leave the fenced JSON visible in
  // source mode).
  const format: 'modern' | 'legacy-inline-closer' = m[1] ? 'legacy-inline-closer' : 'modern';
  // Find the first ``` after the open marker.
  const fenceOpen = source.indexOf('```', openStart + m[0].length);
  if (fenceOpen === -1) return null;
  // JSON body starts on the next line after ```.
  const jsonStart = source.indexOf('\n', fenceOpen);
  if (jsonStart === -1) return null;
  // Find closing fence.
  const fenceClose = source.indexOf('```', jsonStart + 1);
  if (fenceClose === -1) return null;
  const jsonEnd = lastNonNewlineBefore(source, fenceClose);
  // After the closing fence we expect a trailing `%%` line.
  let end = fenceClose + 3;
  // Skip past the optional newline after the closing fence.
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
  if (source[end] === '\r') end += 1;
  if (source[end] === '\n') end += 1;
  // Skip the trailing `%%` line if it exists.
  if (source.startsWith('%%', end)) {
    end += 2;
    while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
    if (source[end] === '\r') end += 1;
    if (source[end] === '\n') end += 1;
  }
  const json = source.slice(jsonStart + 1, jsonEnd);
  return {
    start: lineStart,
    end,
    raw: source.slice(lineStart, end),
    json,
    jsonStart: jsonStart + 1,
    jsonEnd,
    format,
  };
}

/* -------------------------------------------------------------- */
/* Archive break + heading                                         */
/* -------------------------------------------------------------- */

export function findArchiveBreak(source: string, from = 0): SentinelMatch | null {
  // Match a `***` line that is followed (possibly across blank
  // lines) by a `## Archive` heading.
  const lines = enumerateLines(source, from);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.text.trim() !== '***') continue;
    // peek forward for `## Archive`
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].text.trim();
      if (t === '') continue;
      if (/^##\s+Archive\s*$/.test(t)) {
        return { start: ln.start, end: ln.end, raw: source.slice(ln.start, ln.end) };
      }
      break;
    }
  }
  return null;
}

export function findArchiveHeading(source: string, from = 0): SentinelMatch | null {
  const lines = enumerateLines(source, from);
  for (const ln of lines) {
    if (/^##\s+Archive\s*$/.test(ln.text.trim())) {
      return { start: ln.start, end: ln.end, raw: source.slice(ln.start, ln.end) };
    }
  }
  return null;
}

/* -------------------------------------------------------------- */
/* Complete-lane markers                                           */
/* -------------------------------------------------------------- */

const COMPLETE_RE = /^\s*\*\*Complete\*\*\s*$/;

export function findCompleteMarkers(source: string, from = 0): SentinelMatch[] {
  const out: SentinelMatch[] = [];
  for (const ln of enumerateLines(source, from)) {
    if (COMPLETE_RE.test(ln.text)) {
      out.push({ start: ln.start, end: ln.end, raw: source.slice(ln.start, ln.end) });
    }
  }
  return out;
}

/* -------------------------------------------------------------- */
/* Line iteration helper                                          */
/* -------------------------------------------------------------- */

interface LineSpan {
  start: number;
  /** end is one past the final character including any trailing \n */
  end: number;
  text: string;
}

function enumerateLines(source: string, from: number): LineSpan[] {
  const out: LineSpan[] = [];
  let i = from;
  while (i < source.length) {
    const nl = source.indexOf('\n', i);
    const end = nl === -1 ? source.length : nl + 1;
    let textEnd = nl === -1 ? source.length : nl;
    if (textEnd > i && source[textEnd - 1] === '\r') textEnd -= 1;
    out.push({ start: i, end, text: source.slice(i, textEnd) });
    if (nl === -1) break;
    i = end;
  }
  return out;
}

function findLineStart(source: string, at: number): number {
  let i = at;
  while (i > 0 && source[i - 1] !== '\n') i -= 1;
  return i;
}

function lastNonNewlineBefore(source: string, at: number): number {
  let i = at;
  while (i > 0 && (source[i - 1] === '\n' || source[i - 1] === '\r')) i -= 1;
  return i;
}

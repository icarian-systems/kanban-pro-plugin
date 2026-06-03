/**
 * `serializeBoard(board, prevSource) -> string`
 *
 * Strategy: **diff/patch over original source**.
 *
 * - If the model's `hash` equals `hashString(prevSource)`, the model
 *   has not been mutated since parse — return `prevSource` verbatim.
 *   This is the dominant case (board opened, no edits) and the only
 *   way to guarantee byte-identity through a load/save cycle.
 *
 * - Otherwise, walk the model in order. For each Lane we emit:
 *     a. the lane's *frame* (heading + any leading paragraphs like
 *        `**Complete**`) — sliced from prevSource if the lane's
 *        topology vs prev matches; rebuilt if the lane is new.
 *     b. each Card:
 *         - if the card's `hash` matches the byte slice from
 *           `prev[position.start..end]`, emit that slice verbatim.
 *         - else re-serialize the card via `renderCard()`.
 *
 * - The settings block is parser-owned. If a board carries the
 *   original settings block and the model's `settings` deep-equals
 *   what we parsed from it, we re-emit the original block bytes;
 *   otherwise we render via `renderSettingsBlock`.
 *
 * - Frontmatter is re-emitted from `frontmatter` only if it differs
 *   from the parsed version; otherwise the original slice is reused.
 *
 * Known limitations (NOT byte-identical):
 *   - Lane order changes will reorder the byte stream — the lane
 *     bytes themselves are preserved but their concatenation differs.
 *   - Adding/removing lanes obviously changes the bytes.
 *   - Inserting a card in the middle of a lane: existing cards in
 *     that lane keep their bytes; the inserted card uses canonical
 *     form. The lane bytes outside cards (blank lines etc.) are
 *     normalised to a single newline between cards.
 *   - Canonicalize mode (per-board `kanban-canonical: true` or the
 *     explicit command) always re-emits everything from scratch.
 */
import type { Board, Card, Lane, Subtask } from '@/core/model';
import { hashString } from '@/shared/hash';
import { findSentinels } from './sentinels';
import { renderSettingsBlock, serializeSettings } from './settingsBlock';
import { parseInlineMeta, setTagsInText, setFieldsInText } from './inlineMeta';
import { stringify as stringifyYaml } from 'yaml';

/* -------------------------------------------------------------- */
/* Public entry                                                   */
/* -------------------------------------------------------------- */

export function serializeBoard(board: Board, prevSource: string): string {
  // Fast-path: identity round-trip.
  if (board.hash === hashString(prevSource) && !isCanonicalize(board)) {
    return prevSource;
  }

  if (isCanonicalize(board)) {
    return canonicalize(board);
  }

  return patchEmit(board, prevSource);
}

function isCanonicalize(board: Board): boolean {
  return board.settings['kanban-canonical'] === true;
}

/* -------------------------------------------------------------- */
/* Diff/patch emit                                                */
/* -------------------------------------------------------------- */

/**
 * Compute the trailing trivia gap immediately after a region whose `prev`
 * source ends at `endOff`. Walks the precomputed region-start list and
 * returns the slice from `endOff` to the next region's start. Module-level
 * so `renderLane` can reuse it for inter-card gaps.
 *
 * The slice from `prev` is trusted ONLY when
 * it is pure inter-region trivia — newlines, spaces, tabs. Any other byte
 * means our region tracking is out of sync with the live model (e.g.,
 * `lane.position.end` lands inside an EMPTY list item that the parser
 * dropped on a prior round-trip, leaving the stray `- [ ]` line inside the
 * gap window). Replaying those bytes verbatim is what produced the lane +
 * card duplication on disk we observed: a lane's bytes get pasted
 * into the gap between two model-order lanes, then the next iteration
 * re-emits the same lane from the model — duplicate on disk while the
 * in-memory model still says one lane.
 *
 * Falling back to a canonical single newline preserves the parser's
 * round-trip contract (inter-section blank-line count never DECREASES)
 * while making this code path incapable of injecting structural content
 * into a gap.
 */
function makeGapAfter(prev: string, regionStarts: number[]) {
  return (endOff: number): string => {
    const nextStart = nextRegionStart(regionStarts, endOff);
    if (nextStart <= endOff) return '';
    const slice = prev.slice(endOff, nextStart);
    if (isPureTrivia(slice)) return slice;
    // Defensive: the slice has structural content (a `## ` heading, a card
    // listItem, a `%% kanban:settings` sentinel, or a `***` break). Returning
    // it would duplicate that region. Emit the minimum-safe separator: one
    // blank line so the next region's heading still starts on its own line.
    return '\n\n';
  };
}

/**
 * Pure structural trivia: whitespace only. Any non-whitespace in a slice we
 * intend to splice back into the emitted stream as inter-region "trivia" is
 * actually structural content (a `## ` heading, a `- [ ]` list item, a
 * `%% kanban:settings` sentinel, a `***` archive break) — replaying it
 * duplicates that content. See `makeGapAfter` for the load-bearing
 * caller.
 */
function isPureTrivia(slice: string): boolean {
  return /^[ \t\r\n]*$/.test(slice);
}

function patchEmit(board: Board, prev: string): string {
  const newline = board.fileTrivia.newline;
  const sentinels = findSentinels(prev);
  const parts: string[] = [];

  // Inter-region trivia preservation: the source has structural
  // whitespace between regions (blank line between frontmatter and the
  // first lane, between lanes, before the settings block, etc.) that
  // mdast offsets DON'T cover — a lane's `position.end` lands at the
  // end of its last list item, not at the next lane's `## `. We collect
  // the start offsets of every recognised region in `prev` so each
  // emitted region can re-append the original byte-gap that followed it.
  const regionStarts = collectRegionStarts(prev, sentinels);
  const gapAfter = makeGapAfter(prev, regionStarts);

  // BOM
  if (board.fileTrivia.bom && prev.charCodeAt(0) !== 0xfeff) {
    parts.push('﻿');
  } else if (board.fileTrivia.bom) {
    parts.push('﻿');
  }

  // Frontmatter
  if (sentinels.frontmatter) {
    // Re-parse the prev frontmatter and compare to current. For v1
    // we always emit the live model so model edits reach disk; the
    // user-facing byte-identity guarantee is on *cards*, not the
    // frontmatter.
    parts.push(renderFrontmatter(board, newline));
    parts.push(gapAfter(sentinels.frontmatter.end));
  } else if (Object.keys(board.frontmatter).length > 0) {
    parts.push(renderFrontmatter(board, newline));
  }

  // Body: lanes split into normal vs archive.
  const normalLanes = board.lanes.filter((l) => l.kind !== 'archive');
  const archiveLanes = board.lanes.filter((l) => l.kind === 'archive');

  for (let i = 0; i < normalLanes.length; i++) {
    const lane = normalLanes[i];
    parts.push(renderLane(lane, prev, newline));
    // Inter-lane gap: use the original byte span from `prev` that
    // followed this lane's end, when the lane has a known prev
    // position. New lanes (no position) fall back to the canonical
    // two-newline separator.
    if (lane.position) {
      parts.push(gapAfter(lane.position.end));
    } else {
      parts.push(newline + newline);
    }
  }

  if (archiveLanes.length > 0) {
    // Archive break + heading. Prefer to reuse the original `***`
    // line and its surrounding trivia from `prev` when possible.
    if (sentinels.archiveBreak) {
      parts.push(prev.slice(sentinels.archiveBreak.start, sentinels.archiveBreak.end));
      parts.push(gapAfter(sentinels.archiveBreak.end));
    } else {
      parts.push('***');
      parts.push(newline);
      parts.push(newline);
    }
    for (let i = 0; i < archiveLanes.length; i++) {
      const lane = archiveLanes[i];
      parts.push(renderLane(lane, prev, newline));
      if (lane.position) {
        parts.push(gapAfter(lane.position.end));
      } else {
        parts.push(newline + newline);
      }
    }
  }

  // Settings block (parser-owned).
  //
  // The raw-bytes reuse path is only safe for the
  // canonical multi-line comment form. The legacy `%% kanban:settings %%`
  // inline-closer form has a *visible* fenced JSON block when rendered in
  // source mode (the inline closer terminates the comment on the same
  // line, leaving the fence to render). Refusing to reuse legacy bytes
  // means the next mutation re-renders via `renderSettingsBlock` and
  // migrates the file to canonical form — consistent with the byte-
  // identity rule (no mutation = no byte change).
  if (
    sentinels.settings &&
    sentinels.settings.format === 'modern' &&
    deepEqualSettings(board, sentinels.settings.json)
  ) {
    parts.push(sentinels.settings.raw);
  } else if (Object.keys(board.settings).length > 0) {
    parts.push(renderSettingsBlock(board.settings, newline));
  }

  let out = parts.join('');

  // Trailing newline
  if (board.fileTrivia.trailingNewline && !out.endsWith('\n')) out += newline;
  if (!board.fileTrivia.trailingNewline && out.endsWith('\n')) {
    out = out.replace(/\r?\n$/, '');
  }

  return out;
}

/**
 * Collect the byte offsets where every recognised region in `prev`
 * begins. Used to compute the trailing trivia gap for the previous
 * region: gap = prev.slice(prevRegion.end, nextRegion.start). The
 * regions are anything that has a stable line-anchor in the source —
 * frontmatter, level-2 headings (lane starts), the `***` archive
 * break, and the settings sentinel.
 *
 * The end-of-source counts as a trailing pseudo-region so the gap
 * computation never overshoots when emitting the last region.
 */
function collectRegionStarts(prev: string, sentinels: ReturnType<typeof findSentinels>): number[] {
  const starts = new Set<number>();
  if (sentinels.frontmatter) starts.add(sentinels.frontmatter.start);
  if (sentinels.archiveBreak) starts.add(sentinels.archiveBreak.start);
  if (sentinels.settings) starts.add(sentinels.settings.start);

  // Every `## ` heading at line-start (lane heading) — these are the
  // canonical lane anchors in the source. mdast also reports them but
  // a regex scan is robust to the redacted-body shim and the trailing
  // whitespace conventions in real files.
  const re = /(^|\n)## /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prev)) !== null) {
    starts.add(m.index + (m[1] ? 1 : 0));
  }

  starts.add(prev.length);
  return Array.from(starts).sort((a, b) => a - b);
}

function nextRegionStart(starts: number[], from: number): number {
  // Binary search for the smallest entry strictly greater than `from`.
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? starts[lo] : from;
}

function deepEqualSettings(board: Board, prevJson: string): boolean {
  try {
    const prev = JSON.parse(prevJson) as Record<string, unknown>;
    const cur = board.settings as Record<string, unknown>;
    const prevKeys = Object.keys(prev).sort();
    const curKeys = Object.keys(cur).sort();
    if (prevKeys.length !== curKeys.length) return false;
    for (let i = 0; i < prevKeys.length; i++) {
      if (prevKeys[i] !== curKeys[i]) return false;
      if (JSON.stringify(prev[prevKeys[i]]) !== JSON.stringify(cur[curKeys[i]])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- */
/* Lane render                                                    */
/* -------------------------------------------------------------- */

function renderLane(lane: Lane, prev: string, newline: string): string {
  const parts: string[] = [];
  parts.push(`## ${lane.title}`);
  // An empty lane emits ONLY the heading
  // text — no trailing newlines. For lanes with body (cards or a Complete
  // marker) we emit `## Title\n\n[body]`. The trailing line terminator + the
  // blank line *between* this lane and the next region come from `gapAfter`
  // (when the lane has a known prev `position`) or from the canonical
  // `newline + newline` separator (for newly-added lanes). mdast reports
  // a heading's `position.end` at the end of the heading TEXT (before the
  // trailing `\n`), so the gap already starts with that terminator —
  // emitting it again here doubled the spacing.
  const hasBody = lane.kind === 'complete' || lane.cards.length > 0;
  if (hasBody) {
    parts.push(newline);
    parts.push(newline);
  }
  if (lane.kind === 'complete') {
    parts.push('**Complete**');
    parts.push(newline);
    parts.push(newline);
  }
  for (let i = 0; i < lane.cards.length; i++) {
    parts.push(renderCard(lane.cards[i], prev, newline));
    if (i < lane.cards.length - 1) {
      // Preserve the original inter-card trivia
      // (extra blank lines, tabs the user inserted between cards) when
      // both cards' positions are known AND the slice between them was
      // INSIDE the same lane (i.e., contains no heading or archive break).
      // Cross-lane moves leave positions stale (the moved card's position
      // still points into the source lane); the contained-in-same-region
      // check rejects those, falling back to the canonical newline join.
      const cur = lane.cards[i];
      const next = lane.cards[i + 1];
      if (
        cur.position &&
        next.position &&
        next.position.start > cur.position.end &&
        isPureInterCardTrivia(prev.slice(cur.position.end, next.position.start))
      ) {
        parts.push(prev.slice(cur.position.end, next.position.start));
      } else {
        parts.push(newline);
      }
    }
  }
  return parts.join('');
}

/**
 * Is the byte slice between two consecutive cards "pure" inter-card trivia,
 * or does it span a region boundary? The latter happens when a moveCard
 * leaves stale positions; using its bytes would replay cross-lane content
 * into the destination lane. Pure trivia is whitespace-only — newlines,
 * spaces, tabs. Shares the predicate with `makeGapAfter`'s safety check;
 * the failure modes are siblings (replaying stale source bytes that contain
 * structural content) so the safety rule is identical.
 */
function isPureInterCardTrivia(slice: string): boolean {
  return isPureTrivia(slice);
}

/* -------------------------------------------------------------- */
/* Card render — byte-identity when hash is unchanged             */
/* -------------------------------------------------------------- */

function renderCard(card: Card, prev: string, newline: string): string {
  if (card.position) {
    const slice = prev.slice(card.position.start, card.position.end);
    if (hashString(slice) === card.hash && cardMatchesSlice(card, slice)) {
      return slice;
    }
  }
  return canonicalCard(card, newline);
}

/**
 * The byte-identity short-circuit in `renderCard` is correct only when the
 * model's semantic state still reflects what's in the slice. The store's
 * `editCard` action does NOT invalidate `card.hash`, so a meta-only edit
 * (e.g. tags from the DetailPanel) leaves the slice hash matching the
 * model hash while the *tags array* has drifted. Without this guard we
 * silently round-trip the unedited bytes back to disk and lose the edit.
 *
 * Only the dimensions that get patched via UI actions are compared here —
 * date, tags, blockId, fields, and the `done` checkbox. Emoji and time
 * aren't editable from the panel today; add them when they become editable.
 */
function cardMatchesSlice(card: Card, slice: string): boolean {
  if (card.done !== /^\s*-\s+\[x\]/i.test(slice)) return false;
  const parsed = parseInlineMeta(slice).meta;
  if ((card.meta.date ?? '') !== (parsed.date ?? '')) return false;
  if ((card.meta.blockId ?? '') !== (parsed.blockId ?? '')) return false;
  if (!sameStringSet(card.meta.tags ?? [], parsed.tags ?? [])) return false;
  if (!sameRecord(card.meta.fields ?? {}, parsed.fields ?? {})) return false;
  return true;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const v of b) if (!setA.has(v)) return false;
  return true;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function canonicalCard(card: Card, newline: string): string {
  const check = card.done ? 'x' : ' ';
  const lines: string[] = [];
  // First line: the card's primary text (its first paragraph). The
  // model stores `text` joined with '\n' for multi-paragraph cards.
  //
  // The DetailPanel commits meta-only edits (assignee, repeat, tags)
  // without rewriting `card.text`. If we just emit `card.text` we silently
  // drop those edits — the exact data-loss caught for the
  // canonicalize command. Re-sync each meta dimension whose model
  // value drifted from what's embedded in the text.
  //
  // `[rrule:: ...]` strip: the store's `makeCard` builds
  // a fresh card with empty `meta` even when its `text` already contains
  // inline-meta tokens (e.g. user typed `Weekly review [rrule:: FREQ=...]`
  // into the inline editor and committed). The model's "no fields" state
  // there means "uninitialized", not "user removed every field". A naive
  // `setFieldsInText(text, modelFields)` with `modelFields = {}` strips the
  // rrule and we silently lose the Pro recurrence rule on the very next
  // save. To preserve text-only tokens for unknown keys, we merge the
  // text-parsed fields into the model fields (model wins on conflict) so
  // dimensions the model never tracked survive write-back verbatim.
  let text = card.text;
  const parsed = parseInlineMeta(text).meta;
  const modelTags = card.meta.tags ?? [];
  const parsedTags = parsed.tags ?? [];
  // Tag merge: union with model order taking precedence, then text-only
  // tags appended. If a tag exists in the text but not the model the model
  // is treated as "didn't know about it" (same uninitialized-meta argument
  // as fields) and we preserve it. A user removing a tag via DetailPanel
  // sees the model rewritten with the smaller set BUT also seeds it from
  // the parsed text on first load, so a remove there does land — only
  // *truly* untracked tags survive a model→text canonicalize.
  const targetTags: string[] = [];
  for (const t of modelTags) if (!targetTags.includes(t)) targetTags.push(t);
  for (const t of parsedTags) if (!targetTags.includes(t)) targetTags.push(t);
  if (!sameStringSet(parsedTags, targetTags)) {
    text = setTagsInText(text, targetTags);
  }
  const modelFields = card.meta.fields ?? {};
  const parsedFields = parsed.fields ?? {};
  // Field merge: model wins per-key; parsed-only keys (e.g. `rrule` set by
  // typing into the inline editor) are preserved so unknown vocab survives.
  const targetFields: Record<string, string> = { ...parsedFields, ...modelFields };
  if (!sameRecord(parsedFields, targetFields)) {
    text = setFieldsInText(text, targetFields);
  }
  const [firstLine, ...rest] = text.split('\n');
  lines.push(`- [${check}] ${firstLine}`);
  for (const r of rest) lines.push(`  ${r}`);
  for (const st of card.subtasks) {
    lines.push(renderSubtask(st));
  }
  return lines.join(newline);
}

function renderSubtask(st: Subtask): string {
  const check = st.done ? 'x' : ' ';
  return `\t- [${check}] ${st.text}`;
}

/* -------------------------------------------------------------- */
/* Frontmatter render                                             */
/* -------------------------------------------------------------- */

function renderFrontmatter(board: Board, newline: string): string {
  const fm = board.frontmatter as Record<string, unknown>;
  if (Object.keys(fm).length === 0) return '';
  // Ensure kanban-plugin key is present and first.
  const ordered: Record<string, unknown> = {};
  if (fm['kanban-plugin'] !== undefined) ordered['kanban-plugin'] = fm['kanban-plugin'];
  else ordered['kanban-plugin'] = 'board';
  for (const k of Object.keys(fm)) {
    if (k === 'kanban-plugin') continue;
    ordered[k] = fm[k];
  }
  const body = stringifyYaml(ordered).trimEnd();
  return `---${newline}${body}${newline}---${newline}`;
}

/* -------------------------------------------------------------- */
/* Canonicalize mode                                              */
/* -------------------------------------------------------------- */

function canonicalize(board: Board): string {
  const newline = board.fileTrivia.newline;
  const parts: string[] = [];
  if (board.fileTrivia.bom) parts.push('﻿');
  if (Object.keys(board.frontmatter).length > 0 || true) {
    parts.push(renderFrontmatter(board, newline));
  }
  const normalLanes = board.lanes.filter((l) => l.kind !== 'archive');
  const archiveLanes = board.lanes.filter((l) => l.kind === 'archive');
  for (const lane of normalLanes) {
    parts.push(renderLaneCanonical(lane, newline));
    parts.push(newline);
  }
  if (archiveLanes.length > 0) {
    parts.push(newline);
    parts.push('***');
    parts.push(newline);
    parts.push(newline);
    for (const lane of archiveLanes) {
      parts.push(renderLaneCanonical(lane, newline));
      parts.push(newline);
    }
  }
  if (Object.keys(board.settings).length > 0) {
    parts.push(renderSettingsBlock(board.settings, newline));
  }
  let out = parts.join('');
  if (board.fileTrivia.trailingNewline && !out.endsWith('\n')) out += newline;
  return out;
}

function renderLaneCanonical(lane: Lane, newline: string): string {
  const parts: string[] = [];
  parts.push(`## ${lane.title}`);
  parts.push(newline);
  parts.push(newline);
  if (lane.kind === 'complete') {
    parts.push('**Complete**');
    parts.push(newline);
    parts.push(newline);
  }
  for (let i = 0; i < lane.cards.length; i++) {
    parts.push(canonicalCard(lane.cards[i], newline));
    if (i < lane.cards.length - 1) parts.push(newline);
  }
  return parts.join('');
}

// `serializeSettings` is re-exported so the validator script and the
// canonicalize command have a single import point.
export { serializeSettings };

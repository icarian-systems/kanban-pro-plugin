/**
 * Core domain model for Kanban Pro.
 *
 * Every parsed node carries a SourcePosition so write-back can be a
 * diff/patch over the original source for any card whose content hash
 * is unchanged. Byte-identity on untouched cards is the migration
 * guarantee — keep it intact.
 */

export interface SourcePosition {
  start: number;
  end: number;
}

export interface FileTrivia {
  bom: boolean;
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
  originalSource: string;
}

export interface InlineMeta {
  date?: string;
  time?: string;
  tags: string[];
  blockId?: string;
  fields: Record<string, string>;
  emoji: Record<string, string>;
}

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
  position?: SourcePosition;
}

export interface Card {
  id: string;
  text: string;
  done: boolean;
  position?: SourcePosition;
  hash: string;
  meta: InlineMeta;
  subtasks: Subtask[];
}

/**
 * The effective due date for a card, normalized across all inline-meta
 * surfaces:
 *  - `meta.date` from `@{YYYY-MM-DD}` syntax (highest priority)
 *  - `meta.emoji.due` from Tasks-plugin `📅 YYYY-MM-DD` syntax
 *  - `meta.fields.due` from dataview `[due:: YYYY-MM-DD]` syntax
 *
 * Returns the first one set, or undefined if none. Centralising this here
 * keeps Card chips, Dashboard counters, saved-view predicates, and the
 * vault index summarisation in agreement about what "this card is due X"
 * means — an inconsistency between Board view (chip renders) and Dashboard
 * (counter is zero) was rooted in three different call sites each reading a
 * different subset.
 */
export function cardDue(card: Card): string | undefined {
  if (card.meta.date) return card.meta.date;
  const fieldDue = card.meta.fields?.['due'];
  if (typeof fieldDue === 'string' && fieldDue.length > 0) return fieldDue;
  const emojiDue = card.meta.emoji?.['due'];
  if (typeof emojiDue === 'string' && emojiDue.length > 0) return emojiDue;
  // Hand-authored fixtures and legacy round-trips occasionally key the
  // Tasks-plugin date by the glyph itself rather than the canonical
  // `'due'` slot — accept that shape too so the Card chip + Dashboard
  // counter don't disagree on a card whose meta was authored by hand.
  const emojiGlyphDue = card.meta.emoji?.['📅'];
  if (typeof emojiGlyphDue === 'string' && emojiGlyphDue.length > 0) {
    return emojiGlyphDue;
  }
  return undefined;
}

export type LaneKind = 'normal' | 'complete' | 'archive';

export interface Lane {
  id: string;
  title: string;
  kind: LaneKind;
  cards: Card[];
  position?: SourcePosition;
  collapsed: boolean;
}

export type ViewMode = 'board' | 'table' | 'list';

export interface BoardSettings {
  'kanban-plugin'?: string;
  'date-format'?: string;
  'time-format'?: string;
  'default-view'?: ViewMode;
  'allow-embed-edit'?: boolean;
  'kanban-canonical'?: boolean;
  'lane-width'?: number;
  'archive-with-date'?: boolean;
  [key: string]: unknown;
}

export interface BoardFrontmatter {
  'kanban-plugin'?: string;
  [key: string]: unknown;
}

export interface Board {
  lanes: Lane[];
  frontmatter: BoardFrontmatter;
  settings: BoardSettings;
  fileTrivia: FileTrivia;
  hash: string;
}

export interface ParseError {
  message: string;
  position?: SourcePosition;
  severity: 'warning' | 'error';
}

export interface ParseResult {
  board: Board | null;
  errors: ParseError[];
}

export type LicenseTier = 'free' | 'pro';
export type LicenseState = 'unlicensed' | 'licensed' | 'grace' | 'lapsed';

export interface ProGate {
  tier: LicenseTier;
  state: LicenseState;
  /**
   * Surfaced to the Pro settings pane when the most recent activation
   * attempt failed (network error, malformed key, server rejection).
   * Cleared when a subsequent activate() succeeds. Optional so existing
   * gate constructions (e.g. the unlicensed default) don't have to set it.
   *
   * Shape: `{ message: string; at: number }` where `at` is the epoch ms
   * timestamp from the FSM clock — Pro pane uses it to age stale errors.
   */
  lastError?: { message: string; at: number };
}

export interface SavedView {
  id: string;
  name: string;
  filter: ViewFilter;
  createdAt: string;
}

export interface ViewFilter {
  text?: string;
  tags?: string[];
  assignees?: string[];
  dueBefore?: string;
  dueAfter?: string;
  done?: boolean;
  /**
   * Restrict to cards that carry a recurrence rule. Today the field is
   * sourced from the inline `[rrule:: …]` token on the card body. When set
   * to `true` only cards whose meta.fields.rrule is a non-empty string
   * match; when set to `false` only cards without one match.
   */
  hasRrule?: boolean;
}

export type CardId = string;
export type LaneId = string;
export type SubtaskId = string;

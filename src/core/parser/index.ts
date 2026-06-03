/**
 * Public surface of the parser module.
 *
 * OWNED BY: Parser agent. The View / Store layers compile against
 * this barrel — keep the signatures stable.
 */
import type { Board } from '@/core/model';
import { serializeBoard as serializeBoardImpl } from './write';

export { parseBoard, detectTrivia, computeLineStarts, redactRanges } from './read';
export { serializeSettings } from './write';
export {
  parseInlineMeta,
  emptyMeta,
  type InlineToken,
  type InlineTokenKind,
  type InlineTokenizeResult,
} from './inlineMeta';
export { findSentinels, findFrontmatter, findSettings } from './sentinels';
export { parseSettingsJson, renderSettingsBlock } from './settingsBlock';

/**
 * Serialize a Board back to Markdown. `prevSource` defaults to the
 * trivia-recorded original source so the byte-identity round-trip
 * works without callers having to thread the original through.
 *
 * Pass an explicit `prevSource` only when you've buffered an edited
 * source that hasn't yet been re-parsed (the save queue does this
 * when it coalesces multiple in-flight edits).
 */
export function serializeBoard(board: Board, prevSource?: string): string {
  return serializeBoardImpl(board, prevSource ?? board.fileTrivia.originalSource);
}

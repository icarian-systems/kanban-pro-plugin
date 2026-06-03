/**
 * Starter-board round-trip CI gate.
 *
 * The welcome modal's "Create starter board" CTA writes a real
 * Markdown file into the user's vault. If that file does not
 * round-trip through `parseBoard → serializeBoard` byte-for-byte,
 * then running `Kanban Pro: Validate board` on a starter board will
 * report a byte-diff on a file the plugin itself just produced —
 * exactly the trust-breaking outcome we promise migrators we won't
 * cause.
 *
 * This test locks the contract: edit `renderStarterBoardMarkdown()`
 * and you MUST keep this test green. If it fails after a copy tweak,
 * the new card text introduced a token the parser canonicalizes
 * (e.g. an inline metadata pattern) — re-word the card text rather
 * than relaxing the assertion.
 */
import { describe, it, expect } from 'vitest';
import { parseBoard, serializeBoard } from '@/core/parser';
import { renderStarterBoardMarkdown } from '../starterBoard';

describe('starter board — round-trip', () => {
  it('serialize(parse(starter)) === starter (byte-equal)', () => {
    const src = renderStarterBoardMarkdown();
    const { board, errors } = parseBoard(src);
    expect(
      errors.filter((e) => e.severity === 'error'),
      `parse should produce no errors; got: ${JSON.stringify(errors)}`,
    ).toEqual([]);
    expect(board, 'parse should yield a board').not.toBeNull();
    if (!board) throw new Error('unreachable');
    expect(serializeBoard(board, src)).toBe(src);
  });

  it('contains the three canonical lanes', () => {
    const src = renderStarterBoardMarkdown();
    expect(src).toMatch(/^## Backlog$/m);
    expect(src).toMatch(/^## In Progress$/m);
    expect(src).toMatch(/^## Done$/m);
  });

  it('uses the canonical kanban-plugin frontmatter', () => {
    const src = renderStarterBoardMarkdown();
    expect(src.startsWith('---\nkanban-plugin: board\n---\n')).toBe(true);
  });
});

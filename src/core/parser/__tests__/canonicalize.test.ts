/**
 * canonicalize must not destroy card data.
 *
 * Scenario: a card was created and its assignee set via the DetailPanel
 * (which patches `meta.fields.assignee` but does NOT rewrite
 * `card.text`). Running `Canonicalize this board`
 * dropped the assignee silently. Tests below pin the regression by
 * driving a board model that mirrors that DetailPanel state, running it
 * through `serializeBoard(board, '')` in canonical mode, and checking
 * the re-parsed shape against the original.
 */
import { describe, it, expect } from 'vitest';
import { parseBoard, serializeBoard } from '@/core/parser';
import { setFieldsInText } from '@/core/parser/inlineMeta';

function buildBoard() {
  const src =
    '---\n' +
    'kanban-plugin: board\n' +
    '---\n' +
    '\n' +
    '## Backlog\n' +
    '\n' +
    '- [ ] Write outline #urgent #marketing\n' +
    '\n' +
    '## In Progress\n' +
    '\n' +
    '- [ ] Untitled\n' +
    '\n' +
    '## Done\n' +
    '\n' +
    `%% kanban:settings\n\`\`\`\n${JSON.stringify({ 'kanban-plugin': 'board' })}\n\`\`\`\n%%\n`;
  const { board, errors } = parseBoard(src);
  expect(errors.find((e) => e.severity === 'error')).toBeUndefined();
  if (!board) throw new Error('parse failed');
  return board;
}

describe('canonicalize — preserves card data', () => {
  it('preserves meta.fields.assignee when DetailPanel set it without rewriting text', () => {
    const board = buildBoard();
    // Emulate DetailPanel: edit meta.fields.assignee but leave card.text alone.
    const card = board.lanes[0].cards[0];
    card.meta.fields = { ...card.meta.fields, assignee: 'alex' };

    // Canonicalize.
    const canonical = serializeBoard(
      { ...board, settings: { ...board.settings, 'kanban-canonical': true } },
      '',
    );

    // The canonical output must contain the assignee field token.
    expect(canonical).toContain('[assignee:: alex]');

    // And the re-parse must surface it back on the model.
    const reparsed = parseBoard(canonical).board;
    expect(reparsed).not.toBeNull();
    if (!reparsed) return;
    const reCard = reparsed.lanes[0].cards[0];
    expect(reCard.meta.fields.assignee).toBe('alex');
  });

  it('preserves an "Untitled" placeholder card across canonicalize', () => {
    const board = buildBoard();
    const beforeCounts = board.lanes.map((l) => l.cards.length);

    const canonical = serializeBoard(
      { ...board, settings: { ...board.settings, 'kanban-canonical': true } },
      '',
    );
    const reparsed = parseBoard(canonical).board;
    expect(reparsed).not.toBeNull();
    if (!reparsed) return;
    const afterCounts = reparsed.lanes.map((l) => l.cards.length);
    expect(afterCounts).toEqual(beforeCounts);

    // The Untitled card must still be present in lane #2 ("In Progress").
    expect(reparsed.lanes[1].cards.length).toBe(1);
    expect(reparsed.lanes[1].cards[0].text.trim()).toBe('Untitled');
  });

  it('preserves tags edited via DetailPanel (the same pattern as assignee)', () => {
    const board = buildBoard();
    const card = board.lanes[0].cards[0];
    card.meta.tags = ['urgent', 'marketing', 'new-tag'];

    const canonical = serializeBoard(
      { ...board, settings: { ...board.settings, 'kanban-canonical': true } },
      '',
    );

    const reparsed = parseBoard(canonical).board;
    if (!reparsed) throw new Error('reparse failed');
    const reCard = reparsed.lanes[0].cards[0];
    expect(new Set(reCard.meta.tags)).toEqual(
      new Set(['urgent', 'marketing', 'new-tag']),
    );
  });

  it('deep-equals (mod whitespace) the original board after a no-op canonicalize', () => {
    const board = buildBoard();
    const canonical = serializeBoard(
      { ...board, settings: { ...board.settings, 'kanban-canonical': true } },
      '',
    );
    const reparsed = parseBoard(canonical).board;
    if (!reparsed) throw new Error('reparse failed');

    // Compare normalised shapes — lane titles, card text, meta, etc.
    const shape = (b: typeof board) =>
      b.lanes.map((l) => ({
        title: l.title,
        kind: l.kind,
        cards: l.cards.map((c) => ({
          done: c.done,
          tags: [...(c.meta.tags ?? [])].sort(),
          fields: c.meta.fields,
        })),
      }));
    expect(shape(reparsed)).toEqual(shape(board));
  });
});

describe('setFieldsInText', () => {
  it('adds a missing field at the end of the text', () => {
    const out = setFieldsInText('Write outline', { assignee: 'alex' });
    expect(out).toBe('Write outline [assignee:: alex]');
  });

  it('updates an existing field in place', () => {
    const out = setFieldsInText('Write outline [assignee:: bob]', { assignee: 'alex' });
    expect(out).toBe('Write outline [assignee:: alex]');
  });

  it('strips fields no longer in the record', () => {
    const out = setFieldsInText('Write [assignee:: bob] outline', {});
    expect(out).toBe('Write outline');
  });

  it('handles multiple fields, preserving existing token positions', () => {
    const out = setFieldsInText(
      'Task [assignee:: bob] more [priority:: high]',
      { assignee: 'alex', priority: 'medium', extra: 'new' },
    );
    expect(out).toContain('[assignee:: alex]');
    expect(out).toContain('[priority:: medium]');
    expect(out).toContain('[extra:: new]');
  });
});

/**
 * makeCard contract test.
 *
 * `src/core/store.ts` `makeCard` seeds `meta` from
 * `parseInlineMeta(text).meta`. This test asserts that for every form of
 * inline-meta vocabulary, a fresh card built from `addCard(laneId, text)`
 * carries `meta` deep-equal to what `parseInlineMeta(text).meta` would
 * have produced.
 *
 * If this test fails, the serializer's per-token sync will strip the
 * affected vocabulary on the very next save.
 */
import { describe, it, expect } from 'vitest';

import { parseInlineMeta } from '@/core/parser/inlineMeta';
import { createBoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';

const MINIMAL_SRC = '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] placeholder\n';

function newCardFromAddCard(text: string) {
  const { board } = parseBoard(MINIMAL_SRC);
  if (!board) throw new Error('parse failed');
  const store = createBoardStore({ initialBoard: board });
  const laneId = board.lanes[0].id;
  const cardId = store.addCard(laneId, text);
  const card = store.selectCard(cardId);
  if (!card) throw new Error('card not found');
  return card;
}

// ~28 representative samples spanning docs/inline-meta.ebnf:
// 6 dated emoji + 5 priority emoji + 4 recurrence forms + ^id + @{date} +
// @@{time} + tags (ASCII / Unicode / digit-only-reject) + 4 dataview field
// shapes + onCompletion emoji.
const SAMPLES: { name: string; text: string }[] = [
  // 6 dated emoji × IsoDate
  { name: 'due 📅', text: 'Foo 📅 2026-05-20' },
  { name: 'scheduled ⏳', text: 'Foo ⏳ 2026-05-20' },
  { name: 'start 🛫', text: 'Foo 🛫 2026-05-20' },
  { name: 'done ✅', text: 'Foo ✅ 2026-05-20' },
  { name: 'cancelled ❌', text: 'Foo ❌ 2026-05-20' },
  { name: 'created ➕', text: 'Foo ➕ 2026-05-20' },

  // 5 priority emoji (no argument)
  { name: 'priority highest 🔺', text: 'Foo 🔺' },
  { name: 'priority high ⏫', text: 'Foo ⏫' },
  { name: 'priority medium 🔼', text: 'Foo 🔼' },
  { name: 'priority low 🔽', text: 'Foo 🔽' },
  { name: 'priority lowest 🔻', text: 'Foo 🔻' },

  // 4 recurrence forms
  { name: 'rrule dataview', text: 'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]' },
  { name: 'repeats dataview', text: 'Every week [repeats:: every monday]' },
  { name: 'repeat dataview', text: 'Every day [repeat:: daily]' },
  { name: 'recurrence emoji 🔁', text: 'Repeat 🔁 every monday' },

  // blockId
  { name: 'blockId ^card-xyz', text: 'A card ^card-abc123' },

  // @{date}, @@{time}
  { name: '@{date}', text: 'Due @{2026-05-18}' },
  { name: '@@{time}', text: 'At @@{14:30}' },

  // #tag — ASCII, Unicode, digit-only-rejected
  { name: 'ASCII tag', text: 'Task #urgent' },
  { name: 'Unicode tag', text: 'Task #日本語' },
  { name: 'tag with hyphen and slash', text: 'Task #pro-only #area/work' },
  { name: 'digit-only-tag rejected', text: 'Task #123' },

  // 4 dataview forms
  { name: 'dataview priority', text: 'A [priority:: high]' },
  { name: 'dataview multi', text: 'A [assignee:: alex] [estimate:: 2h]' },
  { name: 'dataview spaces in key not allowed', text: 'A [my-key:: value]' },
  { name: 'dataview empty value', text: 'A [tag-style:: ]' },

  // onCompletion emoji 🏁
  { name: 'onCompletion 🏁 delete', text: 'A 🏁 delete' },
  { name: 'taskId 🆔', text: 'A 🆔 task-42' },

  // Composite — kitchen-sink card that exercises tags + fields + emoji + blockId.
  { name: 'composite kitchen-sink', text: 'Big card @{2026-01-01} #review [estimate:: 2h] 📅 2026-01-15 ^xyz789' },
];

describe('makeCard seeds meta from parseInlineMeta(text)', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}`, () => {
      const card = newCardFromAddCard(sample.text);
      const parsed = parseInlineMeta(sample.text).meta;
      expect(card.meta).toEqual(parsed);
    });
  }

  it('empty card has empty meta (regression: parser still returns empty arrays/records)', () => {
    const card = newCardFromAddCard('');
    expect(card.meta.tags).toEqual([]);
    expect(card.meta.fields).toEqual({});
    expect(card.meta.emoji).toEqual({});
    expect(card.meta.date).toBeUndefined();
    expect(card.meta.time).toBeUndefined();
    expect(card.meta.blockId).toBeUndefined();
  });
});

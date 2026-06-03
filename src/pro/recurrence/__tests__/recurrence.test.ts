import { describe, it, expect } from 'vitest';
import { nextOccurrence, applyCompletion } from '../index';
import type { Card } from '@/core/model';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    text: 'Weekly review',
    done: false,
    hash: '',
    meta: { tags: [], fields: {}, emoji: {} },
    subtasks: [],
    ...overrides,
  };
}

describe('recurrence', () => {
  it('returns null for non-recurring card', () => {
    expect(nextOccurrence(card())).toBeNull();
  });

  it('rolls a weekly rrule forward', () => {
    const c = card({
      meta: { tags: [], fields: { rrule: 'FREQ=WEEKLY;BYDAY=MO' }, emoji: {} },
    });
    const now = new Date('2026-05-14T12:00:00Z'); // Thursday
    const occ = nextOccurrence(c, now);
    expect(occ).not.toBeNull();
    expect(occ!.next.getUTCDay()).toBe(1); // Monday
  });

  it('parses natural-language repeats via chrono', () => {
    const c = card({
      meta: { tags: [], fields: { repeats: 'next monday' }, emoji: {} },
    });
    const now = new Date('2026-05-14T12:00:00Z');
    const occ = nextOccurrence(c, now);
    expect(occ).not.toBeNull();
    expect(occ!.next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('rewrites date tokens in card text', () => {
    const c = card({
      text: 'Weekly review @{2026-05-07} #ops',
      meta: { tags: ['ops'], fields: { rrule: 'FREQ=WEEKLY' }, emoji: {} },
    });
    const occ = nextOccurrence(c, new Date('2026-05-14T12:00:00Z'));
    expect(occ).not.toBeNull();
    expect(occ!.nextCard.text).toMatch(/@\{20\d\d-\d\d-\d\d\}/);
    expect(occ!.nextCard.text).toContain('#ops');
  });

  it('applyCompletion only triggers when card is done', () => {
    const c = card({
      done: false,
      meta: { tags: [], fields: { rrule: 'FREQ=WEEKLY' }, emoji: {} },
    });
    expect(applyCompletion(c)).toBeNull();
    expect(applyCompletion({ ...c, done: true })).not.toBeNull();
  });

  it('resets subtasks on next occurrence', () => {
    const c = card({
      meta: { tags: [], fields: { rrule: 'FREQ=WEEKLY' }, emoji: {} },
      subtasks: [
        { id: 's1', text: 'one', done: true },
        { id: 's2', text: 'two', done: true },
      ],
    });
    const occ = nextOccurrence(c, new Date('2026-05-14T12:00:00Z'));
    expect(occ!.nextCard.subtasks.every((s) => !s.done)).toBe(true);
  });

  it('🔁 emoji recurrence (RRULE form) spawns a successor — Tasks-plugin compat', () => {
    // The parser stores the 🔁 token under its semantic key `recurrence`
    // (EMOJI_TABLE), not the glyph. The engine must read that key.
    const c = card({
      meta: { tags: [], fields: {}, emoji: { recurrence: 'FREQ=WEEKLY;BYDAY=MO' } },
    });
    const occ = nextOccurrence(c, new Date('2026-05-14T12:00:00Z'));
    expect(occ).not.toBeNull();
    expect(occ!.next.getUTCDay()).toBe(1); // Monday
  });

  it('🔁 emoji recurrence (natural-language form) spawns a successor', () => {
    // Tasks authors recurrence as natural language, e.g. `🔁 every week`.
    const c = card({
      meta: { tags: [], fields: {}, emoji: { recurrence: 'every monday' } },
    });
    const now = new Date('2026-05-14T12:00:00Z');
    const occ = nextOccurrence(c, now);
    expect(occ).not.toBeNull();
    expect(occ!.next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('anchors to the card date, not the completion time (late completion)', () => {
    // Card scheduled for a Monday; completed much later. The successor must
    // land on the NEXT scheduled Monday relative to the card's date, not now.
    const c = card({
      text: 'Weekly review @{2026-05-11}',
      meta: { date: '2026-05-11', tags: [], fields: { rrule: 'FREQ=WEEKLY;BYDAY=MO' }, emoji: {} },
    });
    // Pass a far-future `now` to prove it is ignored when the card has a date.
    const occ = nextOccurrence(c, new Date('2027-01-01T00:00:00Z'));
    expect(occ).not.toBeNull();
    expect(occ!.nextCard.meta.date).toBe('2026-05-18');
  });

  it('fan-out — successor must NOT inherit parent blockId (vault uniqueness)', () => {
    const c = card({
      text: 'Weekly review @{2026-05-07} ^card-abc123',
      meta: {
        tags: [],
        fields: { rrule: 'FREQ=WEEKLY' },
        emoji: {},
        blockId: 'card-abc123',
      },
    });
    const occ = nextOccurrence(c, new Date('2026-05-14T12:00:00Z'));
    expect(occ).not.toBeNull();
    // blockId stripped from meta…
    expect(occ!.nextCard.meta.blockId).toBeUndefined();
    // …and from the card-text token.
    expect(occ!.nextCard.text).not.toContain('^card-abc123');
    // The parent's token must not be inherited verbatim.
    expect(occ!.nextCard.text).not.toMatch(/\^card-/);
  });
});

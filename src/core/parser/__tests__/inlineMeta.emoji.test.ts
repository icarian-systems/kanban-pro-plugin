/**
 * inlineMeta.emoji.test.ts — emoji date coverage.
 *
 * The Card render path resolves the due-date from one of three sources:
 *
 *   meta.date           // @{YYYY-MM-DD}
 *   meta.fields.due     // [due:: YYYY-MM-DD]
 *   meta.emoji['due']   // 📅 YYYY-MM-DD  (parser keys by canonical name)
 *
 * The Card component also accepts `meta.emoji['📅']` for legacy fixtures.
 *
 * For the resolution chain to work, all three must normalise to the same
 * `YYYY-MM-DD` string shape — no leading space, no trailing trivia. These
 * tests pin that contract for the Tasks-plugin emoji parser.
 */
import { describe, it, expect } from 'vitest';
import { parseInlineMeta } from '@/core/parser/inlineMeta';

describe('parseInlineMeta — emoji date normalisation', () => {
  it('📅 + space-separated ISO date → meta.emoji.due = "YYYY-MM-DD" (no leading space)', () => {
    const { meta } = parseInlineMeta('Ship it 📅 2026-05-22');
    expect(meta.emoji['due']).toBe('2026-05-22');
  });

  it('📅 + tab whitespace before the date is consumed', () => {
    const { meta } = parseInlineMeta('Ship it 📅\t2026-05-22');
    expect(meta.emoji['due']).toBe('2026-05-22');
  });

  it('📅 with trailing content does NOT bleed into the value', () => {
    // The parser consumes exactly 10 characters of date and stops.
    // Anything after must not appear in the stored value.
    const { meta } = parseInlineMeta('Ship it 📅 2026-05-22 more text here');
    expect(meta.emoji['due']).toBe('2026-05-22');
    expect(meta.emoji['due']).not.toMatch(/\s/);
  });

  it('📅 without a valid date is left unparsed (no key added)', () => {
    const { meta } = parseInlineMeta('Ship it 📅 not-a-date');
    expect(meta.emoji['due']).toBeUndefined();
  });

  it('all three date sources coexist without cross-contaminating', () => {
    // Card text in the wild may carry multiple date signals. The parser
    // captures each into its own slot; the UI's resolution chain decides
    // priority (meta.date wins). The contract here is that *all three*
    // stay in lockstep `YYYY-MM-DD` shape.
    const { meta } = parseInlineMeta(
      'Multi @{2026-05-22} [due:: 2026-05-22] 📅 2026-05-22',
    );
    expect(meta.date).toBe('2026-05-22');
    expect(meta.fields['due']).toBe('2026-05-22');
    expect(meta.emoji['due']).toBe('2026-05-22');
  });
});

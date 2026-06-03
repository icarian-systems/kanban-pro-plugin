/**
 * stripInlineMetaTokens coverage.
 *
 * Card titles render the raw card text minus any recognized inline-meta
 * token (date, time, tag, blockId, field, emoji). Chips below the title
 * already surface the same information; without stripping, users would
 * see the raw `[due:: 2026-05-20]` / `📅 …` / `^card-id` / `#tag` strings
 * INSIDE the title alongside the chip.
 */
import { describe, it, expect } from 'vitest';
import { stripInlineMetaTokens } from '../inlineMeta';

describe('stripInlineMetaTokens', () => {
  it('removes [field:: value] tokens', () => {
    expect(stripInlineMetaTokens('Email vendor [due:: 2026-05-20]')).toBe('Email vendor');
  });

  it('removes ^card-id block tokens', () => {
    expect(stripInlineMetaTokens('Ship feature ^card-e5f6')).toBe('Ship feature');
  });

  it('removes #tag tokens', () => {
    expect(stripInlineMetaTokens('fix #bug now')).toBe('fix now');
  });

  it('removes Tasks-plugin emoji tokens 📅 YYYY-MM-DD', () => {
    expect(stripInlineMetaTokens('Fix lane drag 📅 2026-05-15')).toBe('Fix lane drag');
  });

  it('removes @{YYYY-MM-DD} date tokens', () => {
    expect(stripInlineMetaTokens('Triage @{2026-05-20} now')).toBe('Triage now');
  });

  it('removes multiple tokens of mixed kinds', () => {
    const input = 'Email vendor [due:: 2026-05-20] #bug ^card-a1b2 #urgent';
    expect(stripInlineMetaTokens(input)).toBe('Email vendor');
  });

  it('returns the original text when there are no tokens', () => {
    expect(stripInlineMetaTokens('Plain card title')).toBe('Plain card title');
  });

  it('trims leading/trailing whitespace from the stripped result', () => {
    expect(stripInlineMetaTokens('   #tag   ')).toBe('');
  });

  it('preserves words and punctuation around stripped tokens', () => {
    expect(stripInlineMetaTokens('Call (vendor) #urgent before lunch')).toBe(
      'Call (vendor) before lunch',
    );
  });
});

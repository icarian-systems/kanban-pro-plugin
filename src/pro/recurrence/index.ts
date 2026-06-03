/**
 * Recurrence engine (Pro). Generates the next-occurrence card when a
 * recurring card is marked complete.
 *
 * Input forms (both supported):
 *   - `rrule: FREQ=WEEKLY;BYDAY=MO` (machine-readable, RFC 5545).
 *   - `repeats: every monday at 9am` (natural language via chrono-node).
 *
 * The next occurrence inherits the parent card's text, tags, and meta —
 * minus inline date/time tokens (those are re-rendered for the new date).
 */

import { RRule } from 'rrule';
import * as chrono from 'chrono-node';
import type { Card } from '@/core/model';
import { cardDue } from '@/core/model';
import { log } from '@/shared/log';

export interface NextOccurrence {
  next: Date;
  /** A clean copy of the parent card with date/time updated. */
  nextCard: Card;
}

/** A recurrence rule looks like an RRULE if it carries an RFC-5545 `FREQ=`
 *  clause (or the explicit `RRULE:` prefix); otherwise we treat it as a
 *  natural-language phrase for chrono-node. */
function looksLikeRRule(s: string): boolean {
  return /\bFREQ=/i.test(s) || s.startsWith('RRULE:');
}

/**
 * Compute the next occurrence for a recurring card.
 *
 * Recurrence can be authored three ways, all of which must work:
 *   - `[rrule:: FREQ=...]`           → `meta.fields.rrule` (RFC 5545)
 *   - `[repeats:: every monday]`     → `meta.fields.repeats` (natural language)
 *   - `🔁 ...` (Tasks-plugin emoji)  → `meta.emoji.recurrence` (either form)
 *
 * The 🔁 token (and the DetailPanel free-text input) can carry EITHER an
 * RRULE or a natural-language phrase, so we sniff the shape rather than
 * assume one. The successor is anchored to the card's own scheduled date
 * (`meta.date` / due) when it has one — so completing a card late still
 * advances to the next *scheduled* date, not "now + interval". `now` is only
 * the fallback anchor for undated cards. Returns null if the card is not
 * recurring or there is no further occurrence.
 */
export function nextOccurrence(card: Card, now: Date = new Date()): NextOccurrence | null {
  const candidates: Array<{ value: string; kind: 'rrule' | 'nl' }> = [];
  const rrule = card.meta.fields['rrule'];
  const repeats = card.meta.fields['repeats'];
  const emoji = card.meta.emoji['recurrence'];
  if (rrule) candidates.push({ value: rrule, kind: 'rrule' });
  if (emoji) candidates.push({ value: emoji, kind: looksLikeRRule(emoji) ? 'rrule' : 'nl' });
  if (repeats) candidates.push({ value: repeats, kind: 'nl' });
  if (candidates.length === 0) return null;

  // Anchor at the card's own date so successors track the schedule, not the
  // completion time. Parse the YYYY-MM-DD slot at UTC midnight; fall back to
  // `now` for cards with no date at all.
  const anchorStr = card.meta.date ?? cardDue(card);
  const anchor = anchorStr ? new Date(`${anchorStr}T00:00:00Z`) : now;

  let nextDate: Date | null = null;
  for (const c of candidates) {
    if (c.kind === 'rrule') {
      try {
        const ruleStr = c.value.startsWith('RRULE:') ? c.value : `RRULE:${c.value}`;
        const opts = RRule.parseString(ruleStr);
        // RRULE strings authored inline carry no DTSTART; without one rrule
        // would anchor occurrences at rule-construction time (non-deterministic
        // and wall-clock-dependent). Pin it to the card's anchor.
        if (!opts.dtstart) opts.dtstart = anchor;
        nextDate = new RRule(opts).after(anchor, /* inc */ false);
      } catch (e) {
        log.warn('rrule parse error', e);
      }
    } else {
      const parsed = chrono.parseDate(c.value, anchor, { forwardDate: true });
      if (parsed) nextDate = parsed;
    }
    if (nextDate) break;
  }

  if (!nextDate) return null;

  const isoDate = nextDate.toISOString().slice(0, 10);
  const isoTime = nextDate.toISOString().slice(11, 16);

  // Fan-out: the successor MUST NOT inherit the parent's
  // `meta.blockId`. Two cards sharing a `^card-id` violates the vault-wide
  // uniqueness invariant (Obsidian's block-reference resolver picks the
  // first match arbitrarily). We strip the blockId from meta AND from the
  // text token; a fresh ID will be assigned next time someone references
  // the card.
  const { blockId: _drop, ...metaWithoutBlockId } = card.meta;
  void _drop;
  const nextText = stripBlockIdToken(rewriteDateTokens(card.text, isoDate, isoTime));

  const nextCard: Card = {
    ...card,
    id: `${card.id}-next-${nextDate.getTime()}`,
    done: false,
    text: nextText,
    meta: {
      ...metaWithoutBlockId,
      date: isoDate,
      time: isoTime,
    },
    subtasks: card.subtasks.map((s) => ({ ...s, done: false })),
  };

  return { next: nextDate, nextCard };
}

/**
 * Strip a trailing `^blockid` token from a card-text line. The tokenizer
 * only accepts `^blockid` at end-of-line/end-of-input so a single regex
 * pass per line is sufficient.
 */
function stripBlockIdToken(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s*\^[A-Za-z0-9-]+\s*$/, ''))
    .join('\n');
}

/**
 * Replace any `@{YYYY-MM-DD}` or `@@{HH:mm}` tokens in the card text with
 * the new occurrence's date/time. We don't add tokens that weren't there
 * — if the original card had no date token, the next doesn't get one either.
 */
function rewriteDateTokens(text: string, date: string, time: string): string {
  return text
    .replace(/@\{[^}]+\}/g, `@{${date}}`)
    .replace(/@@\{[^}]+\}/g, `@@{${time}}`);
}

/**
 * Hook called by the store when a card transitions to `done`. If the card
 * has recurrence metadata, returns the next card to insert into the same
 * lane (or null to no-op). The caller decides whether to keep the parent
 * card as 'done' or move it to archive.
 */
export function applyCompletion(card: Card, now: Date = new Date()): Card | null {
  if (!card.done) return null;
  const occ = nextOccurrence(card, now);
  return occ ? occ.nextCard : null;
}

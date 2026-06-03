/**
 * Pure token-substitution for basic templates. Lives in its own module so
 * we can unit-test it without touching plugin persistence.
 */
import type { BasicTemplate, ExpandContext, ExpandedTemplate } from './types';

const CURSOR_TOKEN = '{{cursor}}';
const DATE_TOKEN = '{{date}}';
const TIME_TOKEN = '{{time}}';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function expandTemplate(
  t: BasicTemplate,
  ctx: ExpandContext = {},
): ExpandedTemplate {
  const now = ctx.now ?? new Date();

  // Substitute date/time first — they never produce a cursor token, so
  // doing them before the {{cursor}} extraction is safe.
  let text = t.body
    .split(DATE_TOKEN).join(isoDate(now))
    .split(TIME_TOKEN).join(isoTime(now));

  // Extract first {{cursor}} → record its offset, strip it. Drop remaining
  // {{cursor}} tokens silently (collapsing matches the contract).
  let cursorOffset: number | undefined;
  const firstCursor = text.indexOf(CURSOR_TOKEN);
  if (firstCursor !== -1) {
    cursorOffset = firstCursor;
    text =
      text.slice(0, firstCursor) +
      text.slice(firstCursor + CURSOR_TOKEN.length);
    // Remove any further cursor tokens.
    while (text.includes(CURSOR_TOKEN)) {
      text = text.replace(CURSOR_TOKEN, '');
    }
  }

  return {
    text,
    cursorOffset,
    meta: t.meta,
  };
}

/**
 * Advanced template expansion.
 *
 * Pipeline:
 *   1. Resolve the body — either pass through Templater (if requested + available)
 *      or run our basic substitutor.
 *   2. Resolve `{{var:name}}`, `{{prompt:question}}`, `{{date}}`, `{{time}}`,
 *      `{{cursor}}` against the merged var bag.
 *   3. Compute `cursorOffset` from the `{{cursor}}` token and strip it.
 *   4. Evaluate conditions against the seed meta + template.meta; merge
 *      matching `apply` blocks left-to-right.
 *
 * Determinism: every step is pure given ctx.now (or `new Date()` if not
 * provided) and the input bag. No filesystem reads beyond what Templater
 * itself performs.
 */

import type { InlineMeta } from '@/core/model';
import { parseInlineMeta } from '@/core/parser/inlineMeta';
import type {
  AdvancedTemplate,
  ExpandContext,
  ExpandResult,
  TemplateCondition,
} from './types';
import { runThroughTemplater } from './templater';

const CURSOR_TOKEN = '{{cursor}}';

export async function expandAdvancedTemplate(
  template: AdvancedTemplate,
  ctx: ExpandContext = {},
): Promise<ExpandResult> {
  const now = ctx.now ?? new Date();
  const vars: Record<string, string> = {
    ...(template.vars ?? {}),
    ...(ctx.vars ?? {}),
  };
  const userInput = ctx.userInput ?? {};

  let body = template.body;

  // Step 1: Templater bridge (best-effort).
  if (template.useTemplater) {
    const result = await runThroughTemplater(body, ctx.app);
    if (result.ok) body = result.text;
    // On !ok we silently fall through to basic substitution — Templater is
    // additive, never blocking.
  }

  // Step 2: basic substitution.
  body = substitute(body, { vars, userInput, now });

  // Step 3: extract cursor position.
  const { text, cursorOffset } = extractCursor(body);

  // Step 4: conditions over meta.
  const baseMeta: Partial<InlineMeta> = mergeMeta(template.meta, ctx.seed);
  const conditionMeta = applyConditions(baseMeta, template.conditions ?? []);

  // Fan-out: the template body itself may contain inline
  // tokens (e.g. `Weekly review [rrule:: ...] #urgent`). Merge what we'd
  // parse from `text` into the returned meta so downstream `addCard` /
  // `editCard` consumers don't need to re-parse to avoid the strip-on-save
  // bug. Template/condition values win on conflict; parsed-only keys are
  // preserved (rrule, tags, fields the user wrote into the body).
  const parsedFromText = parseInlineMeta(text).meta;
  const finalMeta = mergeMeta(parsedFromText, conditionMeta);

  return {
    text,
    cursorOffset,
    meta: finalMeta,
  };
}

interface SubstituteBag {
  vars: Record<string, string>;
  userInput: Record<string, string>;
  now: Date;
}

const TOKEN_RE = /\{\{(date|time|var:[^}]+|prompt:[^}]+)\}\}/g;

function substitute(input: string, bag: SubstituteBag): string {
  return input.replace(TOKEN_RE, (full, raw: string) => {
    if (raw === 'date') return isoDate(bag.now);
    if (raw === 'time') return isoTime(bag.now);
    if (raw.startsWith('var:')) {
      const name = raw.slice(4).trim();
      return bag.vars[name] ?? full;
    }
    if (raw.startsWith('prompt:')) {
      const question = raw.slice(7).trim();
      // If the caller has resolved this question, use it. Otherwise leave the
      // token in place so the UI layer can prompt the user.
      return Object.prototype.hasOwnProperty.call(bag.userInput, question)
        ? bag.userInput[question]
        : full;
    }
    return full;
  });
}

function extractCursor(input: string): { text: string; cursorOffset?: number } {
  const idx = input.indexOf(CURSOR_TOKEN);
  if (idx === -1) return { text: input };
  const text = input.slice(0, idx) + input.slice(idx + CURSOR_TOKEN.length);
  return { text, cursorOffset: idx };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoTime(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/** Shallow merge of meta-shaped partials. Arrays unioned, plain fields override. */
function mergeMeta(
  a: Partial<InlineMeta> | undefined,
  b: Partial<InlineMeta> | undefined,
): Partial<InlineMeta> {
  if (!a && !b) return {};
  if (!a) return { ...b };
  if (!b) return { ...a };
  const out: Partial<InlineMeta> = { ...a, ...b };
  if (a.tags || b.tags) {
    out.tags = Array.from(new Set([...(a.tags ?? []), ...(b.tags ?? [])]));
  }
  if (a.fields || b.fields) {
    out.fields = { ...(a.fields ?? {}), ...(b.fields ?? {}) };
  }
  if (a.emoji || b.emoji) {
    out.emoji = { ...(a.emoji ?? {}), ...(b.emoji ?? {}) };
  }
  return out;
}

function applyConditions(
  base: Partial<InlineMeta>,
  conditions: TemplateCondition[],
): Partial<InlineMeta> {
  let meta = base;
  for (const cond of conditions) {
    if (matches(meta, cond.when)) {
      meta = mergeMeta(meta, cond.apply);
    }
  }
  return meta;
}

function matches(meta: Partial<InlineMeta>, when: TemplateCondition['when']): boolean {
  if (when.tagsInclude && when.tagsInclude.length > 0) {
    const tags = meta.tags ?? [];
    for (const t of when.tagsInclude) {
      if (!tags.includes(t)) return false;
    }
  }
  if (when.metaMatches) {
    for (const [k, expected] of Object.entries(when.metaMatches)) {
      // Compare scalar fields and the `fields` map. We don't pretend to
      // structurally match `tags`/`subtasks` here — use tagsInclude for that.
      if (k === 'tags') continue;
      if (k === 'fields') {
        const actualFields = meta.fields ?? {};
        const expectedFields = expected as Record<string, string>;
        for (const [fk, fv] of Object.entries(expectedFields)) {
          if (actualFields[fk] !== fv) return false;
        }
        continue;
      }
      if (k === 'emoji') {
        const actualEmoji = meta.emoji ?? {};
        const expectedEmoji = expected as Record<string, string>;
        for (const [ek, ev] of Object.entries(expectedEmoji)) {
          if (actualEmoji[ek] !== ev) return false;
        }
        continue;
      }
      // scalar match
      if ((meta as Record<string, unknown>)[k] !== expected) return false;
    }
  }
  return true;
}

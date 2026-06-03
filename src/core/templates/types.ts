/**
 * Free-tier basic card templates.
 *
 * Scope: fixed-field snippets with three substitution tokens — {{date}},
 * {{time}}, {{cursor}}. Anything more dynamic (Templater bridge, conditional
 * fields, prompts) lives in src/pro/templates and is paywalled.
 *
 * The store persists templates via plugin.saveData('templates', ...). It is
 * NOT part of the per-board model — templates are user-scoped, not board-
 * scoped.
 */
import type { InlineMeta } from '@/core/model';

export interface BasicTemplate {
  id: string;
  name: string;
  description?: string;
  /**
   * Markdown body, applied as the new card's text. Supports three tokens:
   *   {{date}}    → ISO date (YYYY-MM-DD) at the time of expansion
   *   {{time}}    → HH:mm at the time of expansion
   *   {{cursor}}  → consumed; the resulting offset is returned so callers
   *                 can place the caret there.
   * Multiple {{cursor}} tokens collapse to the first; the rest are dropped.
   */
  body: string;
  /** Optional InlineMeta seed merged on the new card via store.editCard. */
  meta?: Partial<InlineMeta>;
}

export interface ExpandedTemplate {
  /** Final card text with tokens substituted and {{cursor}} stripped. */
  text: string;
  /** Byte offset within `text` where the caret should land, if {{cursor}}
   *  appeared. Undefined when no cursor token was present. */
  cursorOffset?: number;
  /** Pass-through copy of the template's meta seed, for the caller to
   *  forward to store.editCard. */
  meta?: Partial<InlineMeta>;
}

export interface ExpandContext {
  /** Override the clock for deterministic tests. */
  now?: Date;
}

export interface TemplateStore {
  getAll(): BasicTemplate[];
  byId(id: string): BasicTemplate | undefined;
  expand(t: BasicTemplate, ctx?: ExpandContext): ExpandedTemplate;
  upsert(t: BasicTemplate): Promise<void>;
  remove(id: string): Promise<void>;
  /** Subscribe to in-memory mutations. Returns an unsubscribe fn. */
  onChange(cb: () => void): () => void;
}

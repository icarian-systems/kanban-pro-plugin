/**
 * Advanced template types (Pro).
 *
 * Builds on the free `BasicTemplate` contract from `@/core/templates` by
 * layering Templater integration, user variables, and conditional meta
 * application.
 *
 * NOTE: The core/templates barrel may not be in place yet during early
 * integration. We re-declare the structural shape of `BasicTemplate` here so
 * this module is independently typecheckable; once the real export lands,
 * `AdvancedTemplate extends BasicTemplate` resolves transparently
 * through structural compatibility.
 */

import type { InlineMeta } from '@/core/model';

/**
 * Structural mirror of `@/core/templates#BasicTemplate`. Keep in sync if the
 * upstream contract changes — name/description/body/meta only.
 */
export interface BasicTemplateShape {
  id: string;
  name: string;
  description?: string;
  body: string;
  meta?: Partial<InlineMeta>;
}

export interface TemplateCondition {
  /** Predicate evaluated against the current ctx (tags + meta). */
  when: {
    /** Match if every tag in this list is present on the card/seed. */
    tagsInclude?: string[];
    /** Match if every key/value here matches the card/seed meta. */
    metaMatches?: Partial<InlineMeta>;
  };
  /** Meta fields merged into the result when `when` is true. */
  apply: Partial<InlineMeta>;
}

export interface AdvancedTemplate extends BasicTemplateShape {
  /** Route through Templater (if installed) for full scripting power. */
  useTemplater?: boolean;
  /** Named user vars; referenced from the body via `{{var:name}}`. */
  vars?: Record<string, string>;
  /**
   * Conditional meta. Each entry's `when` is evaluated in order;
   * matching entries' `apply` blocks are merged left-to-right so later
   * conditions can override earlier ones.
   */
  conditions?: TemplateCondition[];
}

export interface ExpandContext {
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Caller-supplied vars; merged on top of template.vars. */
  vars?: Record<string, string>;
  /**
   * Resolved answers for `{{prompt:question}}` tokens, keyed by the
   * question text. Frontend wires the actual prompt UI; the engine just
   * looks the value up. Missing keys leave the token in place.
   */
  userInput?: Record<string, string>;
  /** Obsidian app — required for the Templater bridge. */
  app?: import('obsidian').App;
  /**
   * Seed meta/tags representing the card or context the template is being
   * expanded against. Conditions evaluate against this.
   */
  seed?: Partial<InlineMeta>;
}

export interface ExpandResult {
  text: string;
  /** Byte offset of `{{cursor}}` in `text`, if one was present. */
  cursorOffset?: number;
  /** Meta to merge onto the resulting card after conditions are applied. */
  meta?: Partial<InlineMeta>;
}

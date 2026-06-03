/**
 * MarkdownHost — provides Obsidian's `App` and the host `Component` to the
 * React subtree so descendants can invoke `MarkdownRenderer.render` with the
 * correct child-component for cleanup.
 *
 * `KanbanView` is expected to wrap `<BoardRoot>` with
 * `<MarkdownHostProvider app={this.app} component={this}>` (or pass them as
 * props to `BoardRoot`, which forwards them here).
 *
 * Contract notes:
 *  - `component` should be the long-lived view's `Component` (e.g. the
 *    `TextFileView` instance) — every `<MarkdownReadView>` instance creates a
 *    child component under it via `component.addChild(...)`, allowing
 *    granular per-card cleanup when cards unmount.
 *  - `app` is forwarded to `MarkdownRenderer.render(app, md, el, path, child)`.
 *  - For embedded boards (markdown post-processor), `component` is the
 *    `MarkdownPostProcessorContext`'s component reference.
 */
import * as React from 'react';
import { Component, MarkdownRenderer, type App } from 'obsidian';

export interface MarkdownHostValue {
  app: App;
  component: Component;
  /** When true, links open in new pane on cmd/ctrl-click etc. Default true. */
  followLinks?: boolean;
}

const MarkdownHostContext = React.createContext<MarkdownHostValue | null>(null);

export interface MarkdownHostProviderProps extends MarkdownHostValue {
  children: React.ReactNode;
}

export const MarkdownHostProvider: React.FC<MarkdownHostProviderProps> = ({
  app,
  component,
  followLinks = true,
  children,
}) => {
  const value = React.useMemo<MarkdownHostValue>(
    () => ({ app, component, followLinks }),
    [app, component, followLinks],
  );
  return <MarkdownHostContext.Provider value={value}>{children}</MarkdownHostContext.Provider>;
};

export function useMarkdownHost(): MarkdownHostValue | null {
  return React.useContext(MarkdownHostContext);
}

export interface MarkdownReadViewProps {
  markdown: string;
  /** Source path so wikilinks resolve correctly. Optional for embedded use. */
  path?: string;
  /** Optional class name applied to the rendered container. */
  className?: string;
}

/**
 * Trivial markdown emphasis pattern check — fast path so we can skip mounting
 * Obsidian's renderer for plain-text strings that contain no bold/italic/code.
 * False positives (e.g. an asterisk inside a URL) are harmless: the renderer
 * still produces the right output for them.
 */
const INLINE_MD_RE = /\*\*|__|[*_]\S|`[^`\n]+`|\[[^\]]+\]\(/;
export function hasInlineMarkdown(s: string): boolean {
  if (!s) return false;
  return INLINE_MD_RE.test(s);
}

/**
 * Renders a markdown string into a `<div>` via Obsidian's MarkdownRenderer.
 * Reconciliation: when `markdown`, `path`, or the host context changes, we
 * tear down the previous child component and re-render. This keeps embedded
 * components (transclusions, dataview, etc.) properly registered.
 */
export const MarkdownReadView: React.FC<MarkdownReadViewProps> = ({
  markdown,
  path = '',
  className,
}) => {
  const host = useMarkdownHost();
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Clear previous rendered output using the DOM API (no innerHTML, per
    // Obsidian's security guidelines). Works with and without an Obsidian host.
    while (el.firstChild) el.removeChild(el.firstChild);

    // If we have no Obsidian host (e.g. tests, storybook), fall back to a
    // plaintext rendering so the component still mounts without errors.
    if (!host) {
      el.textContent = markdown;
      return;
    }

    // Create a child component scoped to this render so subcomponents
    // (callouts, embeds) clean up when we re-render.
    const child = new Component();
    host.component.addChild(child);

    // Some Obsidian versions expose `render(app, md, el, path, component)`;
    // older ones expose `renderMarkdown(md, el, path, component)`. Prefer
    // the modern signature, fall back gracefully.
    const renderer = MarkdownRenderer as unknown as {
      render?: (app: App, md: string, el: HTMLElement, path: string, c: Component) => Promise<void>;
      renderMarkdown?: (md: string, el: HTMLElement, path: string, c: Component) => Promise<void>;
    };

    const renderPromise =
      typeof renderer.render === 'function'
        ? renderer.render(host.app, markdown, el, path, child)
        : typeof renderer.renderMarkdown === 'function'
          ? renderer.renderMarkdown(markdown, el, path, child)
          : Promise.resolve();

    // Swallow render errors — failed embeds shouldn't crash the board. Logging
    // happens elsewhere (`shared/log.ts`).
    void renderPromise.catch(() => {
      /* noop */
    });

    return () => {
      host.component.removeChild(child);
    };
  }, [markdown, path, host]);

  return <div ref={containerRef} className={className} />;
};

export interface MarkdownInlineViewProps extends MarkdownReadViewProps {
  /**
   * Element tag for the inline container. Defaults to `span` so the rendered
   * markdown sits inline next to surrounding text (e.g. card titles inside an
   * `<h3>`). Multi-paragraph markdown is collapsed to its first paragraph's
   * inline content — block-level emphasis is not expected for inline use.
   */
  as?: keyof JSX.IntrinsicElements;
}

/**
 * Renders single-line markdown (bold / italic / code / links) for use in
 * compact UI like card titles. Compared to `MarkdownReadView`:
 *   - Strips the outer `<p>` Obsidian's renderer always inserts around
 *     paragraph content, so the result is true inline DOM.
 *   - Only renders the first block — multi-paragraph titles aren't expected.
 *   - Falls back to plaintext when no obsidian host is mounted (tests) or
 *     when the input contains no inline-markdown syntax (fast path; avoids
 *     spawning a child Component for every plain-text card title).
 *
 * Security: the input never reaches `innerHTML` directly — Obsidian's
 * `MarkdownRenderer` parses and emits a sanitized DOM tree. The fallback
 * branch uses `textContent`.
 */
export const MarkdownInlineView: React.FC<MarkdownInlineViewProps> = ({
  markdown,
  path = '',
  className,
  as = 'span',
}) => {
  const host = useMarkdownHost();
  const containerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Clear via DOM API (no innerHTML, per Obsidian's security guidelines).
    while (el.firstChild) el.removeChild(el.firstChild);

    // Fast path: no markdown syntax detected → use textContent, no renderer.
    if (!host || !hasInlineMarkdown(markdown)) {
      el.textContent = markdown;
      return;
    }

    // Render into a detached scratch element so we can extract the inline
    // children of the first paragraph WITHOUT briefly mounting block-level
    // <p> margins inside the title's <h3>.
    const scratch = document.createElement('div');
    const child = new Component();
    host.component.addChild(child);

    const renderer = MarkdownRenderer as unknown as {
      render?: (app: App, md: string, el: HTMLElement, path: string, c: Component) => Promise<void>;
      renderMarkdown?: (md: string, el: HTMLElement, path: string, c: Component) => Promise<void>;
    };

    const promise =
      typeof renderer.render === 'function'
        ? renderer.render(host.app, markdown, scratch, path, child)
        : typeof renderer.renderMarkdown === 'function'
          ? renderer.renderMarkdown(markdown, scratch, path, child)
          : Promise.resolve();

    let cancelled = false;
    void promise
      .then(() => {
        if (cancelled) return;
        // Take the first block element (Obsidian wraps in <p>), and lift its
        // children into the actual container. If we got something other than
        // a block wrapper, just move the whole rendered tree.
        const first = scratch.firstElementChild;
        if (first && (first.tagName === 'P' || first.tagName === 'DIV')) {
          while (first.firstChild) el.appendChild(first.firstChild);
        } else {
          while (scratch.firstChild) el.appendChild(scratch.firstChild);
        }
      })
      .catch(() => {
        // On render failure, fall back to plaintext so the card stays usable.
        if (cancelled) return;
        el.textContent = markdown;
      });

    return () => {
      cancelled = true;
      host.component.removeChild(child);
    };
  }, [markdown, path, host]);

  // The `as` polymorphism here keeps the host element semantic — callers
  // can pass `as="span"` inside an `<h3>` so we don't nest block elements.
  const Tag = as as React.ElementType;
  return <Tag ref={containerRef as React.RefObject<HTMLElement>} className={className} />;
};

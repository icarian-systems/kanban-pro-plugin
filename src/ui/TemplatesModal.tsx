/**
 * TemplatesModal — the Free-tier "insert from template" picker.
 *
 * Lifecycle:
 *   - The `Kanban Pro: Insert from template` command dispatches
 *     `kanban-pro:open-template-modal` on `window` with detail:
 *       { app: App, store: BoardStore, templateStore, laneId?: LaneId }
 *   - This module's `installTemplateModal(app)` (called once from main.ts)
 *     attaches a window listener that opens an Obsidian `Modal`, mounts a
 *     React tree inside it, and tears down on close.
 *
 * The modal is purely Free-tier: no Templater bridge, no scripting. The
 * paid surface lives in src/pro/templates and is mounted separately.
 *
 * UX details:
 *   - Single-column list, name + description.
 *   - Click → expand template, call `store.addCard(laneId, expanded.text)`
 *     (the meta is applied via `editCard` on the returned id so the inline
 *     meta merges through the parser's normal write path).
 *   - "Manage templates" footer link dispatches
 *     `kanban-pro:open-pro-settings` with feature='Templates' so the
 *     Settings tab can navigate to the Templates pane.
 *   - Esc / backdrop click closes via Obsidian's own Modal behaviour.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, Modal, Notice } from 'obsidian';

import type { BoardStore } from '@/core/store';
import type { CardId, InlineMeta, LaneId } from '@/core/model';
import { parseInlineMeta } from '@/core/parser/inlineMeta';
import type { BasicTemplate, TemplateStore } from '@/ui/contracts';

export const TEMPLATE_MODAL_EVENT = 'kanban-pro:open-template-modal';

/**
 * Deep-merge a template's `meta` seed onto the meta parsed from the
 * template's expanded text. Template-supplied keys win on conflict;
 * parsed-only keys (tags, fields, emoji entries the user typed in the
 * template body itself) are preserved.
 */
function mergeTemplateMeta(
  parsed: InlineMeta,
  override: Partial<InlineMeta>,
): Partial<InlineMeta> {
  const out: Partial<InlineMeta> = { ...parsed };
  if (override.date !== undefined) out.date = override.date;
  if (override.time !== undefined) out.time = override.time;
  if (override.blockId !== undefined) out.blockId = override.blockId;
  const tags: string[] = [];
  for (const t of parsed.tags ?? []) if (!tags.includes(t)) tags.push(t);
  for (const t of override.tags ?? []) if (!tags.includes(t)) tags.push(t);
  out.tags = tags;
  out.fields = { ...(parsed.fields ?? {}), ...(override.fields ?? {}) };
  out.emoji = { ...(parsed.emoji ?? {}), ...(override.emoji ?? {}) };
  return out;
}

export interface TemplateModalEventDetail {
  app: App;
  store: BoardStore;
  templateStore: TemplateStore;
  /** When unspecified, falls back to the first non-shipped lane. */
  laneId?: LaneId;
}

interface TemplatesModalProps {
  templates: BasicTemplate[];
  onPick: (t: BasicTemplate) => void;
  onManage: () => void;
  onClose: () => void;
}

const TemplatesModalView: React.FC<TemplatesModalProps> = ({
  templates,
  onPick,
  onManage,
  onClose,
}) => {
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    // Defer focus to next frame so Obsidian's Modal positioning is done.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
    );
  }, [templates, query]);

  // Keyboard nav: ArrowUp / ArrowDown to move highlight; Enter picks.
  const [highlighted, setHighlighted] = React.useState(0);
  React.useEffect(() => {
    if (highlighted >= filtered.length) setHighlighted(0);
  }, [filtered.length, highlighted]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = filtered[highlighted];
      if (t) onPick(t);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="kp-templates-modal" onKeyDown={onKeyDown}>
      <header className="kp-templates-modal__head">
        <h2 className="kp-templates-modal__title">Insert from template</h2>
        <p className="kp-templates-modal__hint">
          Pick a template to add to the current lane. Tokens like{' '}
          <code>{'{{date}}'}</code> and <code>{'{{cursor}}'}</code> are filled
          in automatically.
        </p>
        <input
          ref={inputRef}
          type="text"
          className="kp-templates-modal__search"
          placeholder="Filter templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      <ul className="kp-templates-modal__list" role="listbox">
        {filtered.length === 0 ? (
          <li className="kp-templates-modal__empty">
            No templates match. Create one in <em>Settings → Templates</em>.
          </li>
        ) : (
          filtered.map((t, i) => (
            <li
              key={t.id}
              role="option"
              aria-selected={i === highlighted}
              className={`kp-templates-modal__item${
                i === highlighted ? ' is-highlighted' : ''
              }`}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => onPick(t)}
            >
              <span className="kp-templates-modal__item-name">{t.name}</span>
              {t.description ? (
                <span className="kp-templates-modal__item-desc">
                  {t.description}
                </span>
              ) : null}
            </li>
          ))
        )}
      </ul>

      <footer className="kp-templates-modal__foot">
        <button
          type="button"
          className="kp-templates-modal__manage"
          onClick={onManage}
        >
          Manage templates…
        </button>
        <span className="kp-templates-modal__kbd">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          to navigate, <kbd>↵</kbd> to insert, <kbd>Esc</kbd> to close
        </span>
      </footer>
    </div>
  );
};

class KanbanTemplatesModal extends Modal {
  private root: Root | null = null;
  private host: HTMLElement | null = null;

  constructor(
    app: App,
    private store: BoardStore,
    private templateStore: TemplateStore,
    private laneId: LaneId | undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty?.();
    while (this.contentEl.firstChild) this.contentEl.removeChild(this.contentEl.firstChild);
    this.contentEl.addClass?.('kp-templates-modal-host');
    this.contentEl.classList.add('kp-templates-modal-host');

    const host = document.createElement('div');
    host.className = 'kp-root';
    this.contentEl.appendChild(host);
    this.host = host;

    const templates = this.templateStore.getAll();
    const targetLaneId = this.laneId ?? this.resolveDefaultLane();

    const render = () => {
      this.root?.render(
        <TemplatesModalView
          templates={this.templateStore.getAll()}
          onPick={(t) => this.pick(t, targetLaneId)}
          onManage={() => {
            window.dispatchEvent(
              new CustomEvent('kanban-pro:open-pro-settings', {
                detail: { feature: 'Templates' },
              }),
            );
            this.close();
          }}
          onClose={() => this.close()}
        />,
      );
    };

    this.root = createRoot(host);
    render();

    // If the template store changes while the modal is open (rare, e.g.
    // user runs the manage command from a different window), re-render.
    // Modal subclasses inherit Component#register from CoreBase, but the
    // typed API doesn't surface it — cast through a narrow shim.
    const self = this as unknown as { register?: (cb: () => void) => void };
    self.register?.(this.templateStore.onChange(render));

    if (templates.length === 0) {
      // Don't insta-close — keep the modal open so the user sees the empty
      // state and the "Manage templates" link.
    }
  }

  override onClose(): void {
    try { this.root?.unmount(); } catch { /* noop */ }
    this.root = null;
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.contentEl.empty?.();
    while (this.contentEl.firstChild) this.contentEl.removeChild(this.contentEl.firstChild);
  }

  private resolveDefaultLane(): LaneId | undefined {
    const ids = this.store.selectLaneIds?.() ?? [];
    if (ids.length === 0) return undefined;
    // Prefer a lane that isn't the archive/shipped lane.
    for (const id of ids) {
      const lane = this.store.selectLane?.(id);
      if (lane && (lane.kind ?? 'normal') === 'normal') return id;
    }
    return ids[0];
  }

  private pick(t: BasicTemplate, laneId: LaneId | undefined): void {
    try {
      const expanded = this.templateStore.expand(t);
      if (!laneId) {
        new Notice('No lane available — add a lane first.');
        return;
      }
      const newCardId = this.store.addCard?.(laneId, expanded.text) as CardId | undefined;
      if (newCardId && expanded.meta) {
        // The new card already carries meta
        // parsed from `expanded.text` (makeCard now seeds it). A naive
        // `editCard({ meta: expanded.meta })` shallow-replaces tags/fields/
        // emoji and clobbers what came from the text. Merge expanded.meta
        // on top of the parsed-from-text meta with "explicit wins" semantics
        // so the template's overrides apply but inline tokens survive.
        const parsedFromText = parseInlineMeta(expanded.text).meta;
        const merged = mergeTemplateMeta(parsedFromText, expanded.meta);
        this.store.editCard?.(newCardId, { meta: merged });
      }
      this.close();
    } catch (err) {
      // Surface to user rather than silently dropping the click.
      new Notice(`Template failed to insert: ${(err as Error).message}`);
      console.warn('[kanban-pro] template insert failed', err);
    }
  }
}

/**
 * Install the global listener — call once from `main.ts.onload()` and
 * register the returned cleanup via `plugin.register(() => off())`.
 */
export function installTemplateModal(_app: App): () => void {
  const onOpen = (e: Event) => {
    const detail = (e as CustomEvent<TemplateModalEventDetail>).detail;
    if (!detail?.app || !detail?.store || !detail?.templateStore) {
      console.warn('[kanban-pro] open-template-modal event missing required detail', detail);
      return;
    }
    const modal = new KanbanTemplatesModal(
      detail.app,
      detail.store,
      detail.templateStore,
      detail.laneId,
    );
    modal.open();
  };
  window.addEventListener(TEMPLATE_MODAL_EVENT, onOpen);
  return () => window.removeEventListener(TEMPLATE_MODAL_EVENT, onOpen);
}

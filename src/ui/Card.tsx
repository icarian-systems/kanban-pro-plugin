/**
 * Card — one item in a lane. Body renders via Obsidian's MarkdownRenderer in
 * read mode; click switches to InlineEditor; long-press opens DetailPanel.
 *
 * The card subscribes to its own slice via `store.selectCard(id)`. We never
 * read `state.board` directly here — that would re-render every card on any
 * change.
 */
import * as React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Menu, Platform } from 'obsidian';
import { cardDue, type Card as CardModel, type CardId, type LaneId, type Subtask } from '@/core/model';
import type { BoardStore } from '@/core/store';
import { MarkdownReadView, MarkdownInlineView, hasInlineMarkdown } from '@/ui/MarkdownHost';
import { InlineEditor } from '@/ui/InlineEditor';
import { useLongPress } from '@/ui/hooks/useLongPress';
import { useDnDState } from '@/ui/DnDProvider';
import { useStoreSelector } from '@/ui/hooks/useStoreSelector';
import { CardTrackingChip } from '@/ui/CardTrackingChip';
import { parseInlineMeta } from '@/core/parser/inlineMeta';

export interface CardProps {
  cardId: CardId;
  laneId: LaneId;
  index: number;
  store: BoardStore;
  readOnly?: boolean;
  /** Path of the source file; passed to MarkdownReadView for link resolution. */
  sourcePath?: string;
  onOpenDetail: (cardId: CardId) => void;
}

function useCard(store: BoardStore, cardId: CardId): CardModel | undefined {
  // Immer preserves the card's identity when nothing about it changed, so
  // an Object.is-equality subscription is correct here — see the docstring
  // on `useStoreSelector`.
  return useStoreSelector(store, React.useCallback(
    () => store.selectCard(cardId),
    [store, cardId],
  ));
}

/**
 * Parse a `YYYY-MM-DD` ISO date string as a *local-midnight* Date.
 *
 * `new Date('2026-05-20')` interprets the string as UTC midnight, which in
 * any timezone west of UTC (the typical user) renders as the previous day.
 * That produced an "off by one day" defect. The split + 3-arg Date
 * constructor pins the calendar day to the user's local timezone.
 *
 * Returns `null` for unparseable input (caller falls back to raw string).
 */
function parseLocalDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  // Tolerate leading/trailing whitespace — the emoji parser trims, but
  // some user content may not.
  const trimmed = dateStr.trim();
  // Accept either bare `YYYY-MM-DD` or a longer ISO string by taking the
  // first 10 characters. We validate the resulting calendar date below.
  if (trimmed.length < 10) return null;
  const head = trimmed.slice(0, 10);
  if (head[4] !== '-' || head[7] !== '-') return null;
  const [yStr, mStr, dStr] = head.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/**
 * Parses a date-ish string (`YYYY-MM-DD`) and returns the classification used
 * for the `.due` chip (`'overdue' | 'soon' | 'normal' | 'done'`).
 */
function classifyDue(dateStr: string | undefined, done: boolean, now = new Date()): 'overdue' | 'soon' | 'normal' | 'done' {
  if (!dateStr) return 'normal';
  if (done) return 'done';
  const d = parseLocalDate(dateStr);
  if (!d) return 'normal';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((target - today) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'overdue';
  if (days <= 7) return 'soon';
  return 'normal';
}

/**
 * Friendly date label.
 *   - Today / Tomorrow / Yesterday for the ±1d window
 *   - `Overdue · Mon D` for past dates
 *   - `Weekday Mon D` for any future date (e.g. "Wed May 20")
 *
 * The previous implementation returned just the weekday ("Thu") for the
 * 0..7d window, which is ambiguous in long backlogs where every Thursday
 * looks alike. We now always include `Mon D` so the user can disambiguate
 * a card due "Thu May 22" from one due "Thu May 29" at a glance.
 *
 * Date parsing is local-TZ (see parseLocalDate) so a card due
 * "2026-05-20" renders as "Wed, May 20" in every timezone, not the prior
 * day in negative UTC offsets.
 */
function formatDueLabel(dateStr: string, now = new Date()): string {
  const d = parseLocalDate(dateStr);
  if (!d) return dateStr;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((target - today) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `Overdue · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const DueIcon: React.FC<{ done?: boolean }> = ({ done }) =>
  done ? (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M3 7l3 3 5-6" />
    </svg>
  ) : (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="2" y="3" width="10" height="9" rx="0.6" />
      <path d="M2 6h10M5 1.5v3M9 1.5v3" />
    </svg>
  );

const RecurIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
    <path d="M3 7a4 4 0 0 1 7-2.5L11 6m0-3v3h-3M11 7a4 4 0 0 1-7 2.5L3 8m0 3v-3h3" />
  </svg>
);

const TemplateIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
    <rect x="2.5" y="2.5" width="9" height="9" rx="0.8" />
    <path d="M2.5 5h9" />
  </svg>
);

const CheckIcon: React.FC = () => (
  <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.6}>
    <path d="M1 4l2 2 4-4" />
  </svg>
);

/**
 * Strip inline-meta tokens (`#tag`,
 * `^blockid`, `[k:: v]`, `📅 2026-01-01`) from the title text so they don't
 * leak into the rendered `<h3>` while ALSO appearing as chips below the
 * title. Otherwise the title renders the raw line — `Draft Q2 OKRs
 * #planning [due:: 2026-05-20] ^card-c3d4` — and the chips repeat the
 * same data underneath, producing duplicated-tag, raw-block-id, and raw-
 * date-token symptoms.
 *
 * We re-use `parseInlineMeta` (the parser-owned tokenizer) so the strip
 * set and the chip set agree by construction: every token that goes into
 * `card.meta` is exactly the set of tokens that leave the title. Date
 * tokens (`@{YYYY-MM-DD}`) and Tasks emoji (`📅 2026-01-01`) get stripped
 * too — their values surface via the date chip.
 */
function stripInlineMetaTokens(line: string): string {
  if (!line) return line;
  const { tokens } = parseInlineMeta(line);
  if (tokens.length === 0) return line;
  // Walk tokens in reverse so offsets don't shift as we splice.
  const ordered = [...tokens].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const t of ordered) {
    if (t.start < cursor) continue; // overlapping tokens — keep first.
    out += line.slice(cursor, t.start);
    cursor = t.end;
  }
  out += line.slice(cursor);
  // Collapse the double-spaces left behind by mid-string token removal,
  // then trim. Doesn't touch user-meaningful single spaces.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function deriveTitleAndBody(text: string): { title: string; body: string } {
  // Cards represent a single task-list item. The first non-empty line is the
  // title; remaining lines (indented continuation) are the body.
  const trimmed = (text ?? '').replace(/^\s+/, '').replace(/\s+$/, '');
  const newlineIdx = trimmed.indexOf('\n');
  const titleLine = newlineIdx < 0 ? trimmed : trimmed.slice(0, newlineIdx).trim();
  const body = newlineIdx < 0 ? '' : trimmed.slice(newlineIdx + 1).replace(/^\s+/, '');
  // Strip inline-meta tokens so they don't render as raw text in the
  // <h3> (the chips below the title already surface this data).
  return { title: stripInlineMetaTokens(titleLine), body };
}

function initialsOf(name: string): string {
  if (!name) return '??';
  const parts = name.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarClass(assignee: string): string {
  // Deterministic avatar tint — pick one of four palette variants based on a
  // stable hash of the initials. The palette uses three tints (accent / green
  // / amber) plus a neutral, applied via the existing
  // `kp-avatar.is-*` classes defined in `src/styles/card.css`. The
  // additional initials-derived suffix is preserved so CSS can opt in to a
  // per-assignee override if needed.
  const initials = initialsOf(assignee).toLowerCase();
  let hash = 0;
  for (let i = 0; i < initials.length; i++) {
    hash = (hash * 31 + initials.charCodeAt(i)) | 0;
  }
  const palette = ['is-accent', 'is-green', 'is-amber', 'is-red'] as const;
  const tint = palette[Math.abs(hash) % palette.length];
  return `kp-avatar ${tint} kp-avatar--${initials}`;
}

const SubtaskRow: React.FC<{
  subtask: Subtask;
  onToggle: () => void;
}> = ({ subtask, onToggle }) => (
  <div className={`kp-subtask${subtask.done ? ' is-done' : ''}`}>
    <button
      type="button"
      className={`kp-check${subtask.done ? ' is-done' : ''}`}
      aria-label={subtask.done ? 'Mark subtask not done' : 'Mark subtask done'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {subtask.done ? <CheckIcon /> : null}
    </button>
    <span>{subtask.text}</span>
  </div>
);

export const Card: React.FC<CardProps> = ({
  cardId,
  laneId,
  index,
  store,
  readOnly = false,
  sourcePath,
  onOpenDetail,
}) => {
  const card = useCard(store, cardId);
  const [editing, setEditing] = React.useState(false);
  const { isDragging: anyDragging } = useDnDState();

  const sortable = useSortable({
    id: cardId,
    data: { type: 'card', laneId, index },
    disabled: readOnly || editing,
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  // Long press → detail panel
  //
  // Tolerance is set BELOW dnd-kit's PointerSensor activation distance
  // of 6px, so any pointer movement large enough to start a drag also
  // cancels the long-press timer. Without this, a slow drag (finger barely
  // moving for ~350ms before crossing the dnd threshold) would race the
  // long-press timer and open the DetailPanel instead of relocating the
  // card. Read `anyDragging` through a ref so the timeout callback sees the
  // latest value rather than the stale render-time closure.
  const anyDraggingRef = React.useRef(anyDragging);
  React.useEffect(() => { anyDraggingRef.current = anyDragging; }, [anyDragging]);
  const longPressHandlers = useLongPress({
    tolerance: 4,
    onLongPress: () => {
      if (readOnly) return;
      if (anyDraggingRef.current) return;
      onOpenDetail(cardId);
    },
  });

  // Track mount state across async event-driven state updates. The
  // `kanban-pro:focus-new-card` window listener (and the long-press timer
  // above) can fire after a complex card has been unmounted by a drag-end
  // reflow, producing React #185 ("setState on unmounted component"). The
  // guard is cheap and applies to any async setState path on this card.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // focus the inline editor when Column.tsx broadcasts that this card
  // was just created. The event carries the new cardId; we match against
  // our own id and flip into editing mode if equal. Cleanup is mandatory
  // (no global listener left behind on unmount).
  React.useEffect(() => {
    if (readOnly) return;
    const onFocusNew = (e: Event) => {
      const detail = (e as CustomEvent<{ cardId?: string }>).detail;
      if (detail?.cardId === cardId) {
        // async event handler; component may have unmounted between
        // the dispatch and our listener firing. Skip setState if so.
        if (mountedRef.current) setEditing(true);
      }
    };
    window.addEventListener('kanban-pro:focus-new-card', onFocusNew);
    return () => window.removeEventListener('kanban-pro:focus-new-card', onFocusNew);
  }, [cardId, readOnly]);

  const onClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      if (anyDragging) return;
      // Clicking a subtask button / link / icon inside the card shouldn't
      // open the editor.
      const t = e.target as HTMLElement;
      if (t.closest('a, button, input, .kp-check, .kp-subtask, .kp-card-done-toggle')) return;
      // Broadcast for any other open editor so they commit first.
      window.dispatchEvent(new CustomEvent('kanban-pro:card-clicked', { detail: { cardId } }));
      setEditing(true);
    },
    [anyDragging, cardId, readOnly],
  );

  // If the card is removed underneath us, render nothing.
  if (!card) return null;

  const { title, body } = deriveTitleAndBody(card.text);
  const meta = card.meta;
  const tags = meta.tags ?? [];
  // `cardDue` resolves across @{YYYY-MM-DD}, [due:: …], and
  // 📅 emoji syntaxes so every consumer (Card chip, filter engine,
  // Dashboard counter, vault index) agrees on the same value.
  const due = cardDue(card);
  const dueKind = classifyDue(due, card.done);
  const assignee = meta.fields?.assignee ?? meta.fields?.assigned ?? '';
  const isRecurring = Boolean(meta.fields?.rrule || meta.fields?.repeats || meta.fields?.repeat || meta.emoji?.['🔁']);
  const isTemplate = Boolean(meta.fields?.template);
  const activeTimer = meta.fields?.['timer-active'];

  const subtaskDone = card.subtasks.filter((s) => s.done).length;
  const subtaskTotal = card.subtasks.length;
  const subtaskPct = subtaskTotal > 0 ? Math.round((subtaskDone / subtaskTotal) * 100) : 0;

  // Compose long-press and dnd-kit pointer handlers — order matters because
  // each event must reach BOTH handlers (long-press for detection, dnd-kit
  // for drag activation). We run long-press first, then delegate.
  const dndListeners = listeners ?? {};
  const composedPointerDown = (e: React.PointerEvent) => {
    longPressHandlers.onPointerDown(e);
    (dndListeners as Record<string, ((ev: React.PointerEvent) => void) | undefined>).onPointerDown?.(e);
  };

  // L5 — Desktop right-click context menu. The long-press handler's own
  // `onContextMenu` only suppresses the native browser menu on touch
  // (after a long-press fired); we layer the Obsidian Menu on top for
  // desktop right-click. Mobile keeps the existing long-press → DetailPanel
  // flow unchanged.
  const onCardContextMenu = (e: React.MouseEvent) => {
    // Run long-press's contextmenu handler first — it preventDefaults when
    // a touch long-press just fired, which we want to preserve.
    longPressHandlers.onContextMenu(e);
    if (!Platform.isDesktop) return;
    if (readOnly) return;
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(card.done ? 'Mark not done' : 'Mark done')
        .onClick(() => {
          store.toggleCardDone?.(cardId);
        });
    });
    // Archive: store exposes archiveCard at src/core/store.ts:367.
    menu.addItem((item) => {
      item
        .setTitle('Archive')
        .onClick(() => {
          store.archiveCard?.(cardId);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Delete')
        .onClick(() => {
          store.deleteCard?.(cardId);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Open detail')
        .onClick(() => {
          onOpenDetail(cardId);
        });
    });
    menu.showAtMouseEvent(e.nativeEvent);
  };

  // Completion checkbox at the card's left edge. Always visible
  // (we removed the prior opacity:0 hover-reveal so the affordance reads
  // on touch/scan, not just on hover). pointerdown is stopPropagation'd so
  // dnd-kit doesn't try to initiate a drag from the checkbox itself.
  const onCheckboxPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
  };
  const onCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };
  const onCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    store.toggleCardDone?.(cardId);
  };

  // The tracking chip used to render on every card in the free tier,
  // showing a stray "Pro" badge on stock content. We pass the chip a
  // `freeTierAffordance` flag so it stays hidden for free users unless the
  // card already has a real Pro feature attached (active timer, time-tracked
  // field). Pro users always get the chip — its own logic chooses
  // Start/Stop/duration internally.
  const hasTrackingMeta = Boolean(
    activeTimer
    || meta.fields?.tracked
    || meta.fields?.['time-tracked']
    || meta.fields?.['time-spent'],
  );

  return (
    <li
      ref={setNodeRef}
      className={`kp-card${card.done ? ' is-done' : ''}${isDragging ? ' is-dragging' : ''}`}
      style={style}
      data-card-id={cardId}
      onClick={onClick}
      onPointerMove={longPressHandlers.onPointerMove}
      onPointerUp={longPressHandlers.onPointerUp}
      onPointerCancel={longPressHandlers.onPointerCancel}
      onContextMenu={onCardContextMenu}
      {...attributes}
      {...dndListeners}
      onPointerDown={composedPointerDown}
    >
      {/* Completion checkbox at the card's left edge. Always
          visible so the affordance reads on touch/scan, not just on
          hover. Click/drag isolation lives on onPointerDown so dnd-kit
          doesn't pick this up as a drag start. */}
      <input
        type="checkbox"
        className="kp-card-done-toggle"
        checked={card.done}
        aria-label={card.done ? 'Mark card not done' : 'Mark card done'}
        onPointerDown={onCheckboxPointerDown}
        onClick={onCheckboxClick}
        onChange={onCheckboxChange}
      />
      {/* only render the rendered title when NOT editing. The previous
          layout left the read-mode <h3> mounted above the inline editor,
          producing a double-render of the title that read as "broken dev
          preview". Now editing fully replaces the rendered title+body. */}
      {!editing ? (
        <h3 className="kp-card-title">
          {/* render markdown emphasis (`**bold**`, `*italic*`, `` `code` ``)
              in card titles via Obsidian's renderer. Plain titles take the
              fast text-content path; titles containing inline-md syntax mount
              a transient renderer that strips the outer <p> wrapper. Never
              `innerHTML`'d — sanitization happens inside MarkdownRenderer.
              W2.1 — inline-meta tokens (`[due:: …]`, `📅 …`, `^card-id`,
              `#tag`) are already stripped from `title` inside
              `deriveTitleAndBody` so the chips below the title don't
              duplicate them. */}
          {!title ? (
            <span className="kp-card-title__empty">Untitled</span>
          ) : hasInlineMarkdown(title) ? (
            <MarkdownInlineView markdown={title} path={sourcePath} />
          ) : (
            title
          )}
        </h3>
      ) : null}

      {editing ? (
        <InlineEditor
          cardId={cardId}
          initialValue={card.text}
          autoFocus
          onCommit={(next) => {
            store.editCard?.(cardId, { text: next });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : body ? (
        <MarkdownReadView className="kp-card-body" markdown={body} path={sourcePath} />
      ) : null}

      {subtaskTotal > 0 ? (
        <div className="kp-subtasks">
          {card.subtasks.map((s) => (
            <SubtaskRow
              key={s.id}
              subtask={s}
              onToggle={() => store.toggleSubtask?.(cardId, s.id)}
            />
          ))}
          <div className="kp-progress">
            <span>{subtaskDone} / {subtaskTotal}</span>
            <span className="kp-progress-bar"><i style={{ width: `${subtaskPct}%` }} /></span>
            <span>{subtaskPct}%</span>
          </div>
        </div>
      ) : null}

      <div className="kp-card-meta">
        {due ? (
          <span className={`kp-due${dueKind === 'normal' ? '' : ` is-${dueKind}`}`}>
            <DueIcon done={dueKind === 'done'} />
            {dueKind === 'done' ? formatDueLabel(due) : formatDueLabel(due)}
          </span>
        ) : null}

        {isRecurring ? (
          <span className="kp-ico-flag is-recur" title="Recurring">
            <RecurIcon />
          </span>
        ) : null}
        {isTemplate ? (
          <span className="kp-ico-flag is-template" title="From template">
            <TemplateIcon />
          </span>
        ) : null}

        {activeTimer ? (
          <span className="kp-timer">
            <span className="kp-pulse" />
            {activeTimer}
          </span>
        ) : null}

        <CardTrackingChip cardId={cardId} freeTierAffordance={hasTrackingMeta} />

        {tags.map((tag) => (
          <span key={tag} className="kp-tag">{tag.replace(/^#/, '')}</span>
        ))}

        {/* surface ^card-XXXX block IDs as a small monospace pill so
            they're visually distinct from tags (which used to absorb them
            as `#card-XXXX` look-alikes). The parser already strips the
            leading caret; we render it back in the chip for legibility. */}
        {meta.blockId ? (
          <span className="kp-blockid">^{meta.blockId.replace(/^\^/, '')}</span>
        ) : null}

        {assignee ? (
          <span className="kp-assignee">
            <span className={avatarClass(assignee)}>{initialsOf(assignee)}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
};

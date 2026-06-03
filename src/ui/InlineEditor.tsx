/**
 * InlineEditor — controlled editor that replaces a Card's read-mode body
 * while the user is editing.
 *
 * Commit triggers (per spec — never commit only on Enter):
 *   - `blur`
 *   - `dragstart` anywhere on the board (DnDProvider dispatches this)
 *   - click on another card (CardClickAway broadcast)
 *   - `Enter` (only when `singleLine` is true; otherwise Enter inserts a newline)
 *   - `Cmd/Ctrl+S`
 *
 * Cancel triggers:
 *   - `Escape` reverts to the original value and closes.
 *
 * The editor body uses `useCM6Editor` (textarea fallback for v0; CM6 later).
 */
import * as React from 'react';
import { useCM6Editor } from '@/ui/hooks/useCM6Editor';

export interface InlineEditorProps {
  initialValue: string;
  onCommit: (next: string) => void;
  onCancel?: () => void;
  /** When true, Enter commits instead of inserting a newline. */
  singleLine?: boolean;
  /** Auto-focus on mount; defaults true. */
  autoFocus?: boolean;
  placeholder?: string;
  /**
   * Optional source-of-truth id used by the click-away broadcaster so other
   * cards can tell *this* editor to commit when they're clicked.
   */
  cardId?: string;
}

export const InlineEditor: React.FC<InlineEditorProps> = ({
  initialValue,
  onCommit,
  onCancel,
  singleLine = false,
  autoFocus = true,
  placeholder,
  cardId,
}) => {
  // Track committed-once so blur after Enter-commit doesn't double-fire.
  const committedRef = React.useRef(false);
  const valueRef = React.useRef(initialValue);

  // Capture the initial value at mount so we can later distinguish
  // "edited an existing card to empty" (commit '') from "added a card,
  // typed nothing, clicked away" (discard the placeholder). The second
  // case is a UX trap — a stray "Untitled" card every time the user
  // changes their mind.
  const initialWasEmpty = initialValue.trim() === '';

  const broadcastDiscard = React.useCallback(() => {
    if (!cardId) return;
    window.dispatchEvent(
      new CustomEvent('kanban-pro:discard-empty-card', { detail: { cardId } }),
    );
  }, [cardId]);

  const broadcastCommitted = React.useCallback(() => {
    if (!cardId) return;
    window.dispatchEvent(
      new CustomEvent('kanban-pro:card-committed', { detail: { cardId } }),
    );
  }, [cardId]);

  const commit = React.useCallback(
    (next: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      // if the user added a placeholder card and clicked away without
      // typing anything substantive, route through the discard path so
      // Column.tsx can delete the orphan. We compare against the initial
      // value to avoid silently deleting a card the user *intentionally*
      // cleared (initial had text → user blanked it → keep the empty card).
      if (initialWasEmpty && next.trim() === '') {
        broadcastDiscard();
        onCancel?.();
        return;
      }
      broadcastCommitted();
      onCommit(next);
    },
    [broadcastCommitted, broadcastDiscard, initialWasEmpty, onCancel, onCommit],
  );

  const cancel = React.useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    // Escape on an empty-from-the-start placeholder also discards.
    // Without this, the user has no keyboard-driven way to abort the
    // "click + Add card, change my mind" flow.
    if (initialWasEmpty) {
      broadcastDiscard();
    }
    onCancel?.();
  }, [broadcastDiscard, initialWasEmpty, onCancel]);

  const editor = useCM6Editor({
    value: initialValue,
    autoFocus,
    placeholder,
    onChange: (v) => {
      valueRef.current = v;
    },
    onCommit: (v) => {
      // Blur / Cmd-S from inside the editor.
      commit(v);
    },
  });

  // Mount editor into the ref.
  const hostRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) editor.mount(el);
      else editor.teardown();
    },
    [editor],
  );

  // Cross-card commit signals.
  React.useEffect(() => {
    const onDragStart = () => commit(valueRef.current);
    const onClickAway = (e: Event) => {
      const detail = (e as CustomEvent<{ cardId?: string }>).detail;
      // Don't commit if the click was on our own card.
      if (cardId && detail?.cardId === cardId) return;
      commit(valueRef.current);
    };
    window.addEventListener('kanban-pro:dragstart', onDragStart);
    window.addEventListener('kanban-pro:card-clicked', onClickAway);
    return () => {
      window.removeEventListener('kanban-pro:dragstart', onDragStart);
      window.removeEventListener('kanban-pro:card-clicked', onClickAway);
    };
  }, [commit, cardId]);

  // Local key handling — Enter (singleLine), Cmd/Ctrl+S, Escape.
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'Enter') {
        if (singleLine && !e.shiftKey) {
          e.preventDefault();
          commit(valueRef.current);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commit(valueRef.current);
      }
    },
    [cancel, commit, singleLine],
  );

  return (
    <div className="inline-editor" onKeyDown={onKeyDown} data-card-id={cardId}>
      <div ref={hostRef} className="inline-editor__host" />
    </div>
  );
};

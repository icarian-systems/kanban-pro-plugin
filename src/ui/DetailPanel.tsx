/**
 * DetailPanel — slide-in drawer with full card body in edit mode + a
 * structured meta form (due-date, tags, assignee, recurrence [Pro]).
 *
 * Lifecycle:
 *   - opened from Card via long-press
 *   - closes on Escape, backdrop click, or its X button
 *   - all writes go through store actions
 *
 * The detail panel uses `useCM6Editor` for the body (so when the hook
 * implementation is swapped, the panel automatically gets a real editor).
 */
import * as React from 'react';
import { useProGate } from '@/pro/license/state';
import type { BoardStore } from '@/core/store';
import type { CardId, Subtask } from '@/core/model';
import { useCM6Editor } from '@/ui/hooks/useCM6Editor';
import { PaywallCard } from '@/ui/PaywallCard';
import { useStoreSelector } from '@/ui/hooks/useStoreSelector';

export interface DetailPanelProps {
  cardId: CardId | null;
  store: BoardStore;
  onClose: () => void;
  readOnly?: boolean;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({ cardId, store, onClose, readOnly }) => {
  const gate = useProGate();

  const card = useStoreSelector(store, React.useCallback(
    () => (cardId ? store.selectCard(cardId) : undefined),
    [store, cardId],
  ));

  // Stable ref to onClose so the document-level listener never goes stale
  // (even though BoardRoot memoises the callback today, future refactors
  // shouldn't be able to silently break this).
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Hold a ref to the panel root so we can focus it on mount — that way
  // Escape keydown events fire on the panel's own subtree first (and our
  // local onKeyDown picks them up) instead of being trapped by whatever
  // had focus when the long-press fired.
  const asideRef = React.useRef<HTMLElement | null>(null);

  // ESC closes panel.
  //
  // Two listeners, belt-and-braces.
  //
  //   1. `document`-capture: we want to intercept Escape before any CM6
  //      keymap or app-level shortcut handler can consume it. Capture phase
  //      fires before bubble; attached to `document` so it works regardless
  //      of where focus currently lives.
  //   2. local onKeyDown on the dialog: covers the case where some host
  //      stops propagation in capture phase upstream of `document` (rare
  //      but observed in testing). Focusing the dialog on mount means
  //      keypresses originate from inside its subtree.
  React.useEffect(() => {
    if (!cardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cardId]);

  // Focus the dialog when it opens so keyboard events flow naturally.
  React.useEffect(() => {
    if (!cardId) return;
    // Defer to next frame so the panel's children (CM6 editor host) have a
    // chance to mount without us yanking focus away from anything that was
    // intentionally focused.
    const id = window.requestAnimationFrame(() => {
      asideRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [cardId]);

  // Body editor — track the live value locally; commit on close / blur.
  const valueRef = React.useRef<string>(card?.text ?? '');
  React.useEffect(() => {
    valueRef.current = card?.text ?? '';
  }, [card?.text]);

  const editor = useCM6Editor({
    value: card?.text ?? '',
    autoFocus: false,
    onChange: (v) => { valueRef.current = v; },
    onCommit: (v) => {
      if (cardId && card && v !== card.text) {
        store.editCard?.(cardId, { text: v });
      }
    },
  });

  const editorHostRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) editor.mount(el);
      else editor.teardown();
    },
    [editor],
  );

  // Tags input uses a local "draft" string so the user can type
  // a literal comma without losing it.
  //
  // Previously the input was controlled directly by `(tags ?? []).join(', ')`,
  // which meant every keystroke ran split → trim → filter(Boolean) → join.
  // Typing `urgent, marketing` collapsed to `urgentmarketing` mid-type because
  // the trailing fragment was empty and got filtered out before the user
  // finished the second tag. We keep a string draft locally; only the parsed
  // array is committed to the store, and the draft re-syncs when the store
  // tags actually change (a different card, or an outside edit).
  const tagsJoined = (card?.meta.tags ?? []).join(', ');
  const [tagsDraft, setTagsDraft] = React.useState<string>(tagsJoined);
  // Sync from store → draft when the joined value changes externally
  // (card switch, external write, undo). Skip the no-op echo where the
  // committed array round-trips back to a join() the user is mid-typing.
  const lastSyncedJoinedRef = React.useRef<string>(tagsJoined);
  React.useEffect(() => {
    if (tagsJoined !== lastSyncedJoinedRef.current) {
      lastSyncedJoinedRef.current = tagsJoined;
      setTagsDraft(tagsJoined);
    }
  }, [tagsJoined]);

  // Recurrence input — same local-draft discipline as Tags. The field used
  // to be controlled directly by the stored value AND `.trim()` the input on
  // every keystroke, so a trailing space (typing "every Monday") was stripped
  // the instant it was typed and the next character appended to "every" —
  // producing "everyMonday" (P4). Keep a raw draft locally; commit a cleaned
  // value to the store; re-sync the draft only when the stored value changes
  // externally (card switch, undo, outside edit).
  const recurValue = card?.meta.fields?.rrule ?? card?.meta.fields?.repeats ?? '';
  const [recurDraft, setRecurDraft] = React.useState<string>(recurValue);
  const lastSyncedRecurRef = React.useRef<string>(recurValue);
  React.useEffect(() => {
    if (recurValue !== lastSyncedRecurRef.current) {
      lastSyncedRecurRef.current = recurValue;
      setRecurDraft(recurValue);
    }
  }, [recurValue]);

  if (!cardId || !card) return null;

  const onClickBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      // Commit before closing.
      if (valueRef.current !== card.text) {
        store.editCard?.(cardId, { text: valueRef.current });
      }
      onClose();
    }
  };

  // NOTE: the current `CardPatch` type accepts only `text` and
  // `done`. The detail panel needs to patch `meta` (date/tags/fields). The
  // casts below are temporary; once `CardPatch` is widened to accept
  // `meta?: Partial<InlineMeta>` (or `meta?: InlineMeta`), we'll drop them.
  type MetaPatch = { meta: typeof card.meta };
  const patchMeta = (patch: MetaPatch) =>
    store.editCard?.(cardId, patch as unknown as Parameters<typeof store.editCard>[1]);

  const onChangeDue = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value || undefined;
    patchMeta({ meta: { ...card.meta, date: next } });
  };

  const commitTags = (raw: string) => {
    const tags = raw.split(',').map((t) => t.trim()).filter(Boolean);
    // Stash the committed join so the post-commit re-render's effect doesn't
    // overwrite the user's literal draft (e.g. trailing ", " they're about
    // to extend with the next tag).
    lastSyncedJoinedRef.current = tags.join(', ');
    patchMeta({ meta: { ...card.meta, tags } });
  };

  const onChangeTagsInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setTagsDraft(raw);
    // Commit on every change — the store array stays correct in real time,
    // but the input keeps the user's literal text so commas/spaces survive.
    commitTags(raw);
  };

  const onBlurTagsInput = (e: React.FocusEvent<HTMLInputElement>) => {
    // On blur, normalise the visible text to the canonical "a, b" form so
    // stray trailing commas / whitespace disappear once the field loses focus.
    const tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
    const normalised = tags.join(', ');
    if (normalised !== e.target.value) setTagsDraft(normalised);
  };

  const onChangeAssignee = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value || '';
    const fields = { ...(card.meta.fields ?? {}) };
    if (next) fields.assignee = next;
    else delete fields.assignee;
    patchMeta({ meta: { ...card.meta, fields } });
  };

  return (
    // Wrap in a fixed backdrop and slide the panel in from the right.
    // Click-outside dismisses (commits in-flight edits first). Drawer body
    // scrolls internally; backdrop covers the whole viewport so click-outside
    // dismissal is reliable on every screen.
    <div className="kp-detail-overlay" role="presentation" onMouseDown={onClickBackdrop}>
      <aside
        ref={asideRef}
        className="kp-detail-panel kp-detail-panel--drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Card details"
        // tabIndex makes the dialog programmatically focusable so the
        // mount-time `focus()` call (above) succeeds and our local
        // keydown handler can pick up Escape inside the panel subtree.
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Backup Escape handler — covers cases where the document-capture
          // listener gets pre-empted by another capture-phase handler
          // upstream (some Obsidian builds).
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (valueRef.current !== card.text) {
              store.editCard?.(cardId, { text: valueRef.current });
            }
            onClose();
          }
        }}
      >
        <header className="kp-detail-header">
          <h2 className="kp-detail-title">Card details</h2>
          <button
            type="button"
            className="kp-detail-close"
            aria-label="Close card details"
            // Close on `onMouseDown` instead of `onClick`.
            //
            // Why: useLongPress installs a window-level click handler at
            // CAPTURE phase that calls `preventDefault + stopPropagation`
            // whenever its internal `firedRef` is still `true`. The flag
            // gets reset by `pointerup` on the card — but when the panel
            // opens immediately on long-press the user's finger releases
            // over the overlay, not the card, so the card's pointerup never
            // fires and the flag stays `true` indefinitely. Every
            // subsequent click anywhere on the page is then swallowed by
            // that capture handler, including this X button.
            //
            // `mousedown` fires before any `click`, so by acting there we
            // dismiss the panel before the broken click-suppression can
            // run. We keep `onClick` as a fallback for hosts where
            // mousedown is intercepted (touch hosts: tapping a button
            // typically synthesises a click without a separate mousedown).
            onMouseDown={(e) => {
              e.stopPropagation();
              // Only close on primary mouse button — middle/right click
              // shouldn't dismiss.
              if (e.button !== 0) return;
              e.preventDefault();
              if (valueRef.current !== card.text) {
                store.editCard?.(cardId, { text: valueRef.current });
              }
              onClose();
            }}
            onClick={(e) => {
              // Same path as mousedown for keyboard activation (Enter on
              // a focused close button fires `click` without `mousedown`).
              e.stopPropagation();
              if (valueRef.current !== card.text) {
                store.editCard?.(cardId, { text: valueRef.current });
              }
              onClose();
            }}
          >
            ×
          </button>
        </header>

        <div className="kp-detail-body">
          <section className="kp-detail-section">
            <h3 className="kp-detail-section-h">Markdown</h3>
            <div ref={editorHostRef} className="kp-detail-editor-host" />
          </section>

          <section className="kp-detail-section">
            <h3 className="kp-detail-section-h">
              <label htmlFor="dp-due">Due date</label>
            </h3>
            <input
              id="dp-due"
              type="date"
              className="kp-input"
              value={card.meta.date ?? ''}
              onChange={onChangeDue}
              disabled={readOnly}
            />
          </section>

          <section className="kp-detail-section">
            <h3 className="kp-detail-section-h">
              <label htmlFor="dp-tags">Tags</label>
            </h3>
            <input
              id="dp-tags"
              type="text"
              className="kp-input"
              placeholder="comma, separated"
              value={tagsDraft}
              onChange={onChangeTagsInput}
              onBlur={onBlurTagsInput}
              disabled={readOnly}
            />
          </section>

          <section className="kp-detail-section">
            <h3 className="kp-detail-section-h">
              <label htmlFor="dp-assignee">Assignee</label>
            </h3>
            <input
              id="dp-assignee"
              type="text"
              className="kp-input"
              value={card.meta.fields?.assignee ?? ''}
              onChange={onChangeAssignee}
              disabled={readOnly}
            />
          </section>

          <section className="kp-detail-section">
            {/* F15 — Recurrence header and its Pro chip are explicit siblings
                with whitespace, instead of two adjacent text nodes that render
                "RecurrencePro". When the user is on the free tier, the Pro
                chip rides on the header; PaywallCard handles the CTA below. */}
            <h3 className="kp-detail-section-h kp-detail-section-h--with-chip">
              <span>Recurrence</span>
              {gate.tier !== 'pro' ? (
                <span className="kp-pro-chip" aria-label="Pro feature">Pro</span>
              ) : null}
            </h3>
            {gate.tier === 'pro' ? (
              <input
                type="text"
                className="kp-input"
                placeholder="e.g. every Monday or FREQ=WEEKLY;BYDAY=MO"
                value={recurDraft}
                onChange={(e) => {
                  // Keep the raw text for display (spaces intact); commit a
                  // cleaned value to the store.
                  const raw = e.target.value;
                  setRecurDraft(raw);
                  const next = raw.trim();
                  const fields = { ...(card.meta.fields ?? {}) };
                  // The recurrence engine reads `fields.rrule` (RFC 5545) and
                  // `fields.repeats` (natural language). Route the input to the
                  // matching key so completing the card actually spawns a
                  // successor; clear both when emptied. (The legacy `repeat`
                  // key was a no-op — nothing read it.)
                  delete fields.repeat;
                  delete fields.rrule;
                  delete fields.repeats;
                  if (next) {
                    if (/\bFREQ=/i.test(next) || next.startsWith('RRULE:')) {
                      fields.rrule = next.replace(/^RRULE:/, '');
                    } else {
                      fields.repeats = next;
                    }
                  }
                  // Record what we committed so the controlled re-render's
                  // sync effect doesn't clobber the user's in-progress draft.
                  lastSyncedRecurRef.current = fields.rrule ?? fields.repeats ?? '';
                  patchMeta({ meta: { ...card.meta, fields } });
                }}
                onBlur={() => {
                  // Normalise the visible text to the stored (trimmed) value
                  // once the field loses focus, so a stray trailing space
                  // disappears after the user is done typing.
                  const normalized = card.meta.fields?.rrule ?? card.meta.fields?.repeats ?? '';
                  if (normalized !== recurDraft) setRecurDraft(normalized);
                }}
                disabled={readOnly}
              />
            ) : (
              <PaywallCard
                feature="Recurrence"
                description="Schedule cards to repeat daily, weekly, monthly, or on a custom RRULE. Completed cards spawn the next occurrence automatically."
                compact
                layout="stack"
              />
            )}
          </section>

          <section className="kp-detail-section">
            <h3 className="kp-detail-section-h">Subtasks</h3>
            <SubtaskList
              cardId={cardId}
              store={store}
              subtasks={card.subtasks}
              readOnly={readOnly}
            />
          </section>
        </div>
      </aside>
    </div>
  );
};

const SubtaskList: React.FC<{
  cardId: CardId;
  store: BoardStore;
  subtasks: Subtask[];
  readOnly?: boolean;
}> = ({ cardId, store, subtasks, readOnly }) => {
  const [draft, setDraft] = React.useState('');
  return (
    <div className="kp-detail-subtasks">
      {subtasks.map((s) => (
        <div key={s.id} className={`kp-subtask${s.done ? ' is-done' : ''}`}>
          <button
            type="button"
            className={`kp-check${s.done ? ' is-done' : ''}`}
            aria-label={s.done ? 'Mark subtask not done' : 'Mark subtask done'}
            onClick={() => store.toggleSubtask?.(cardId, s.id)}
            disabled={readOnly}
          >
            {s.done ? (
              <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <path d="M1 4l2 2 4-4" />
              </svg>
            ) : null}
          </button>
          <input
            type="text"
            className="kp-input kp-detail-subtasks__text"
            defaultValue={s.text}
            disabled={readOnly}
            onBlur={(e) => {
              if (e.target.value !== s.text) {
                store.editSubtask?.(cardId, s.id, e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          {!readOnly ? (
            <button
              type="button"
              className="kp-detail-subtasks__delete"
              aria-label="Delete subtask"
              onClick={() => store.deleteSubtask?.(cardId, s.id)}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}

      {!readOnly ? (
        <form
          className="kp-detail-subtasks__add"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            store.addSubtask?.(cardId, text);
            setDraft('');
          }}
        >
          <input
            type="text"
            className="kp-input"
            placeholder="Add subtask"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      ) : null}
    </div>
  );
};

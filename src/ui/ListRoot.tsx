/**
 * ListRoot — compact list view, grouped by lane.
 *
 * One card per row; lane title becomes a section heading. Click a row to open
 * DetailPanel; double-click the title to inline-edit it.
 */
import * as React from 'react';
import type { BoardStore } from '@/core/store';
import type { CardId, LaneId } from '@/core/model';
import { InlineEditor } from '@/ui/InlineEditor';
import { EmptyState } from '@/ui/banners/EmptyState';
import { useStoreIdList, useStoreSelector } from '@/ui/hooks/useStoreSelector';
import { stripInlineMetaTokens } from '@/core/parser/inlineMeta';

export interface ListRootProps {
  store: BoardStore;
  readOnly?: boolean;
  onOpenDetail: (cardId: CardId) => void;
}

function useLaneIds(store: BoardStore): readonly LaneId[] {
  return useStoreIdList(store, React.useCallback(() => store.selectLaneIds(), [store]));
}

const LaneSection: React.FC<{
  laneId: LaneId;
  store: BoardStore;
  readOnly?: boolean;
  onOpenDetail: (cardId: CardId) => void;
  editingId: CardId | null;
  setEditingId: (id: CardId | null) => void;
}> = ({ laneId, store, readOnly, onOpenDetail, editingId, setEditingId }) => {
  const laneTitle = useStoreSelector(store, React.useCallback(
    () => store.selectLane(laneId)?.title ?? '',
    [store, laneId],
  ));
  const cardIds = useStoreIdList(store, React.useCallback(
    () => store.selectCardIds(laneId),
    [store, laneId],
  ));

  return (
    <section className="kp-list-group">
      <header className="kp-list-group-head">
        <h2 className="kp-list-group-title">{laneTitle}</h2>
        <span className="kp-list-group-count" aria-label={`${cardIds.length} cards`}>{cardIds.length}</span>
      </header>
      <ol className="kp-list-rows">
        {cardIds.map((cardId) => (
          <ListRow
            key={cardId}
            cardId={cardId}
            store={store}
            readOnly={readOnly}
            isEditing={editingId === cardId}
            onEdit={() => setEditingId(cardId)}
            onCommit={(text) => {
              store.editCard?.(cardId, { text });
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
            onOpenDetail={() => onOpenDetail(cardId)}
          />
        ))}
      </ol>
    </section>
  );
};

const ListRow: React.FC<{
  cardId: CardId;
  store: BoardStore;
  readOnly?: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onOpenDetail: () => void;
}> = ({ cardId, store, readOnly, isEditing, onEdit, onCommit, onCancel, onOpenDetail }) => {
  const card = useStoreSelector(store, React.useCallback(
    () => store.selectCard(cardId),
    [store, cardId],
  ));
  if (!card) return null;
  // strip recognized inline-meta tokens from the rendered title;
  // chips below already surface the same info.
  const title = stripInlineMetaTokens(
    (card.text ?? '').split('\n')[0] ?? '',
  );
  return (
    <li
      // emit data-card-id so the BoardRoot CSS-injection filter hides
      // this row when the card isn't in the active visibleIds set.
      data-card-id={cardId}
      className={`kp-list-row${card.done ? ' is-done' : ''}`}
      onClick={onOpenDetail}
    >
      <button
        type="button"
        className={`kp-check${card.done ? ' is-done' : ''}`}
        aria-label={card.done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => {
          e.stopPropagation();
          store.toggleCardDone?.(cardId);
        }}
      >
        {card.done ? (
          <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
            <path d="M1 4l2 2 4-4" />
          </svg>
        ) : null}
      </button>
      <div
        className="kp-list-row-title"
        onDoubleClick={(e) => { e.stopPropagation(); if (!readOnly) onEdit(); }}
      >
        {isEditing ? (
          <InlineEditor
            cardId={cardId}
            initialValue={card.text}
            singleLine
            autoFocus
            onCommit={onCommit}
            onCancel={onCancel}
          />
        ) : (
          // Mirror Card.tsx / TableRoot.tsx — when the card has no
          // text yet (freshly added via store.addCard with no payload),
          // show an "Untitled" placeholder so the row isn't visually
          // blank. The empty class lets Frontend style the placeholder
          // distinctly from a real title without changing this file.
          <span>{title || (
            <span className="kp-list-row-title--empty">Untitled</span>
          )}</span>
        )}
      </div>
      <span className="kp-list-row-meta">
        {card.meta?.date ? <span>{card.meta.date}</span> : null}
        {(card.meta?.tags ?? []).slice(0, 3).map((tag) => (
          <span key={tag} className="kp-tag">{tag.replace(/^#/, '')}</span>
        ))}
      </span>
    </li>
  );
};

export const ListRoot: React.FC<ListRootProps> = ({ store, readOnly, onOpenDetail }) => {
  const laneIds = useLaneIds(store);
  const [editingId, setEditingId] = React.useState<CardId | null>(null);

  if (laneIds.length === 0) return <EmptyState />;

  return (
    <div className="kp-list-root">
      {laneIds.map((laneId) => (
        <LaneSection
          key={laneId}
          laneId={laneId}
          store={store}
          readOnly={readOnly}
          onOpenDetail={onOpenDetail}
          editingId={editingId}
          setEditingId={setEditingId}
        />
      ))}
    </div>
  );
};

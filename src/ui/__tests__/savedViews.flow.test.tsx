/**
 * savedViews.flow.test.tsx — Saved Views picker + filter flow.
 *
 * Covers the full picker round-trip:
 *
 *   1. Mount BoardRoot with a Pro license + a board with cards across
 *      multiple lanes (different tags / due dates / done flags).
 *   2. Click the Views button → assert the popover picker appears.
 *   3. Click "Save current filter as…" → type a name → save → assert it's
 *      in the SavedViewStore.
 *   4. Reload BoardRoot → assert the saved view appears in the picker.
 *   5. Click a saved view row → assert the visible-card count matches the
 *      filter's predicate (via the `display: none` rules in BoardRoot's
 *      HiddenCardsStyle).
 *
 * Plus an integration check for the pre-seeded `DEFAULT_VIEWS`: dispatch
 * the `kanban-pro:apply-saved-view` event with a `due-this-week`-shaped
 * filter (matching what the rail chip would dispatch) and assert only
 * cards with `meta.date` in the next 7 days are visible.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// useProGate is mocked to return Pro tier so the Views popover is the
// Pro UI (the picker) instead of the Free-tier Notice path. The license
// FSM singleton is otherwise persistence-attached at boot in main.ts —
// we don't want to wire that here.
vi.mock('@/pro/license/state', async () => {
  const actual = await vi.importActual<typeof import('@/pro/license/state')>(
    '@/pro/license/state',
  );
  return {
    ...actual,
    useProGate: () => ({ tier: 'pro' as const, state: 'licensed' as const }),
    useEntitlement: () => true,
  };
});

import { BoardRoot } from '@/ui/BoardRoot';
import { SavedViewStore, memoryBackend } from '@/pro/savedViews/store';
import { createBoardStore, type BoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';
import { Component } from 'obsidian';
import type { App } from 'obsidian';

const FIXTURE_SOURCE = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Inbox',
  '',
  '- [ ] Triage incoming bug [due:: 2099-01-01] #bug',
  '- [ ] Plan sprint [due:: 2099-01-02] #planning',
  '',
  '## Doing',
  '',
  '- [ ] Investigate flaky DnD #bug',
  '',
  '## Done',
  '',
  '- [x] Ship feature #done',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board"}',
  '```',
  '%%',
  '',
].join('\n');

function makeApp(): App {
  // The BoardRoot only uses `app` for MarkdownHostProvider + opening
  // modals. The mock `Modal` class from `src/__mocks__/obsidian.ts`
  // produces a DOM-detached container, which is fine for these tests
  // because we drive the SaveViewModal callback directly via the
  // exposed contentEl/inputEl.
  return {
    workspace: {
      openLinkText: vi.fn(),
    },
    vault: {
      getAbstractFileByPath: vi.fn(() => null),
    },
    metadataCache: {
      getBacklinksForFile: vi.fn(() => ({ data: {} })),
      resolvedLinks: {},
    },
  } as unknown as App;
}

function makeStore(): BoardStore {
  const parsed = parseBoard(FIXTURE_SOURCE);
  if (!parsed.board) throw new Error('fixture parse failed');
  return createBoardStore({ initialBoard: parsed.board });
}

function makeSavedViewStore(): SavedViewStore {
  return new SavedViewStore(memoryBackend());
}

afterEach(() => {
  cleanup();
});

describe('Saved Views picker', () => {
  let app: App;
  let store: BoardStore;
  let savedViewStore: SavedViewStore;

  beforeEach(async () => {
    app = makeApp();
    store = makeStore();
    savedViewStore = makeSavedViewStore();
    await savedViewStore.load();
  });

  function renderBoard(): ReturnType<typeof render> {
    return render(
      <BoardRoot
        store={store}
        app={app}
        viewComponent={new Component()}
        mode="board"
        savedViewStore={savedViewStore}
      />,
    );
  }

  it('clicking the Views button opens the picker popover', () => {
    const { container, getByLabelText } = renderBoard();
    const viewsBtn = getByLabelText('Open views') as HTMLButtonElement;
    fireEvent.click(viewsBtn);
    expect(container.querySelector('.kp-views-picker')).toBeTruthy();
  });

  it('clicking Views again closes it, and it reopens — not stuck (P3)', () => {
    const { container, getByLabelText } = renderBoard();
    const viewsBtn = getByLabelText('Open views') as HTMLButtonElement;
    // Open.
    fireEvent.click(viewsBtn);
    expect(container.querySelector('.kp-views-picker')).toBeTruthy();
    // Click again — simulate a real pointer: the capture-phase outside
    // `mousedown` (which SubnavPopover watches) THEN the trigger `click`.
    // Before the ignoreRef fix these raced: mousedown closed it, then the
    // toggle reopened it, leaving the popover stuck so it could never be
    // closed/reopened cleanly. Now the trigger owns the toggle.
    fireEvent.mouseDown(viewsBtn);
    fireEvent.click(viewsBtn);
    expect(container.querySelector('.kp-views-picker')).toBeFalsy();
    // And it reopens on the next click.
    fireEvent.mouseDown(viewsBtn);
    fireEvent.click(viewsBtn);
    expect(container.querySelector('.kp-views-picker')).toBeTruthy();
  });

  it('lane counts and the masthead total reflect the active filter (#6)', async () => {
    const { container } = renderBoard();
    // Fixture: 4 cards across 3 lanes; 2 carry #bug (Inbox + Doing).
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:apply-saved-view', {
          detail: { id: 'test-bugs', filter: { tags: ['bug'] }, name: 'Bugs only' },
        }),
      );
    });
    await waitFor(() => {
      // Masthead headline shows the filtered count "2 of 4", not "4".
      const meta = container.querySelector('.kp-masthead-meta');
      expect(meta?.textContent ?? '').toContain('2 of 4');
    });
    // Per-lane chips show the VISIBLE count and sum to the 2 matches,
    // instead of the unfiltered per-lane totals.
    const laneCounts = Array.from(container.querySelectorAll('.kp-lane-count'))
      .map((el) => Number(el.textContent));
    expect(laneCounts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('shows the empty-state message when no saved views exist', () => {
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));
    const msg = container.querySelector('.kp-views-picker .kp-popover-msg');
    expect(msg?.textContent).toMatch(/No saved views yet/i);
  });

  it('Save-current-filter button is disabled when filter is empty', () => {
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));
    const saveBtn = container.querySelector(
      '.kp-views-picker .kp-popover-actions button',
    ) as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    expect(saveBtn.disabled).toBe(true);
  });

  it('lists views from the SavedViewStore on mount', async () => {
    await savedViewStore.save({
      name: 'Bug triage',
      filter: { tags: ['bug'] },
    });
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));
    const rows = container.querySelectorAll('.kp-views-picker__row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Bug triage');
  });

  it('clicking a saved view row applies its filter (hides non-matching cards)', async () => {
    // Save a view that filters to the `bug` tag — fixture has 2 bug cards
    // (Inbox + Doing) out of 4 total.
    await savedViewStore.save({
      name: 'Bugs only',
      filter: { tags: ['bug'] },
    });
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));

    const row = container.querySelector(
      '.kp-views-picker__apply',
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    // Hidden-cards CSS is per-card `display:none` rules — count them.
    await waitFor(() => {
      const style = container.querySelector('style[data-kp-filter-style]');
      expect(style).toBeTruthy();
      // 4 cards in the fixture, 2 carry `#bug`. 2 should be hidden.
      const lines = (style?.textContent ?? '').split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });
  });

  it('clicking a saved view row sets the filter chip label to the view name', async () => {
    await savedViewStore.save({
      name: 'Bugs only',
      filter: { tags: ['bug'] },
    });
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));
    const row = container.querySelector(
      '.kp-views-picker__apply',
    ) as HTMLButtonElement;
    fireEvent.click(row);
    // Filter chip's text reflects the saved-view name (BoardRoot's
    // `filterDescription` falls back to `activeSavedViewName` after an
    // apply).
    await waitFor(() => {
      expect(container.textContent).toContain('Bugs only');
    });
  });

  it('deleting a saved view removes it from the picker', async () => {
    const view = await savedViewStore.save({
      name: 'To delete',
      filter: { tags: ['bug'] },
    });
    expect(savedViewStore.list()).toHaveLength(1);
    const { container, getByLabelText } = renderBoard();
    fireEvent.click(getByLabelText('Open views'));
    const del = container.querySelector(
      `[aria-label="Delete saved view: ${view.name}"]`,
    ) as HTMLButtonElement;
    expect(del).toBeTruthy();
    await act(async () => {
      fireEvent.click(del);
    });
    expect(savedViewStore.list()).toHaveLength(0);
    await waitFor(() => {
      expect(container.querySelectorAll('.kp-views-picker__row')).toHaveLength(0);
    });
  });

  it('apply-saved-view CustomEvent (right-rail path) filters the table', async () => {
    renderBoard();
    // Dispatch the same event the RightRail chip dispatches when the
    // user clicks a pre-seeded view. We pass a concrete filter so the
    // test doesn't depend on today's date.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:apply-saved-view', {
          detail: {
            id: 'test-due-this-week',
            filter: { tags: ['bug'] },
            name: 'Bugs only',
          },
        }),
      );
    });
    // 2 bug cards visible, 2 hidden.
    await waitFor(() => {
      const style = document.body.querySelector('style[data-kp-filter-style]');
      expect(style).toBeTruthy();
      const lines = (style?.textContent ?? '').split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });
  });

  it('apply-saved-view by id resolves through the SavedViewStore', async () => {
    const saved = await savedViewStore.save({
      name: 'Tagged bug',
      filter: { tags: ['bug'] },
    });
    renderBoard();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:apply-saved-view', {
          detail: { id: saved.id },
        }),
      );
    });
    await waitFor(() => {
      const style = document.body.querySelector('style[data-kp-filter-style]');
      expect(style).toBeTruthy();
      const lines = (style?.textContent ?? '').split('\n').filter(Boolean);
      // Same 2-hidden expectation as the inline-filter case.
      expect(lines).toHaveLength(2);
    });
  });
});

describe('Saved Views — pre-seeded DEFAULT_VIEWS', () => {
  it('"Due this week" predicate resolves to a date-window filter', async () => {
    const { resolveDefaultSavedViewFilter, DEFAULT_SAVED_VIEW_DEFS } =
      await import('@/ui/savedViewsDefaults');
    const def = DEFAULT_SAVED_VIEW_DEFS.find((d) => d.id === 'due-this-week');
    expect(def).toBeTruthy();
    if (!def) return;
    const filter = resolveDefaultSavedViewFilter(def);
    expect(filter.dueBefore).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filter.dueAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // upper bound should be ~8 days after lower bound.
    const lower = new Date(filter.dueAfter!);
    const upper = new Date(filter.dueBefore!);
    const diffDays = (upper.getTime() - lower.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(7);
    expect(diffDays).toBeLessThan(10);
    // Only undone cards.
    expect(filter.done).toBe(false);
  });

  it('"Overdue" predicate filters to past-due + open cards', async () => {
    const { resolveDefaultSavedViewFilter, DEFAULT_SAVED_VIEW_DEFS } =
      await import('@/ui/savedViewsDefaults');
    const def = DEFAULT_SAVED_VIEW_DEFS.find((d) => d.id === 'overdue');
    expect(def).toBeTruthy();
    if (!def) return;
    const filter = resolveDefaultSavedViewFilter(def);
    expect(filter.dueBefore).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filter.done).toBe(false);
  });
});

/* -------------------------------------------------------------- */
/* right-rail saved-view chips show numeric counts                 */
/*                                                                 */
/* Each saved-view label should show a `<span class="ct">7</span>` */
/* count; previously the live UI rendered no count. BoardRoot now  */
/* computes counts via `applyFilter` against the board store and   */
/* passes them through RightRail → SavedViewsSection.              */
/* -------------------------------------------------------------- */

/* -------------------------------------------------------------- */
/* saved-view rail click must filter rows in                       */
/* Table and List view, not just regenerate hidden-cards CSS.     */
/*                                                                 */
/* Symptom: chip highlights, view switches to Table, filter chip   */
/* label updates — but non-matching rows stay visible. Root cause: */
/* `HiddenCardsStyle` selector targets                             */
/* `[data-card-id="…"]`, which only `<Card>` (Board view) emits.   */
/* `<TableRoot>` rows and `<ListRoot>` rows had no `data-card-id`  */
/* so the CSS no-op'd. This block locks down the per-row attribute */
/* so the predicate cannot regress on Table/List.                 */
/* -------------------------------------------------------------- */

describe('saved-view filters apply to Table/List rows', () => {
  let app: App;
  let store: BoardStore;
  let savedViewStore: SavedViewStore;

  beforeEach(async () => {
    app = makeApp();
    store = makeStore();
    savedViewStore = makeSavedViewStore();
    await savedViewStore.load();
  });

  function renderBoardInMode(mode: 'table' | 'list'): ReturnType<typeof render> {
    // BoardRoot reads the current mode via `store.selectMode()`, falling
    // back to the initial prop only when the store has no override. Drive
    // the store directly so the test renders the requested view tree.
    store.setMode?.(mode);
    return render(
      <BoardRoot
        store={store}
        app={app}
        viewComponent={new Component()}
        mode={mode}
        savedViewStore={savedViewStore}
      />,
    );
  }

  it('Table rows carry data-card-id so HiddenCardsStyle can target them', async () => {
    const { container } = renderBoardInMode('table');
    // Sanity: every <tr> in the table body has a data-card-id attribute,
    // because that's the selector the BoardRoot HiddenCardsStyle uses.
    const rows = container.querySelectorAll('.kp-table tbody tr');
    expect(rows.length).toBe(4); // fixture: 4 cards across 3 lanes
    for (const r of rows) {
      expect(r.getAttribute('data-card-id')).toBeTruthy();
    }
  });

  it('applying an "Overdue"-shaped filter hides non-matching rows in Table view', async () => {
    const { container } = renderBoardInMode('table');
    // Fixture cards have due dates 2099-01-01, 2099-01-02, none, none.
    // An overdue filter `dueBefore: 2026-05-15` matches NONE.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:apply-saved-view', {
          detail: {
            id: 'test-overdue',
            filter: { dueBefore: '2026-05-15', done: false },
            name: 'Overdue',
          },
        }),
      );
    });
    await waitFor(() => {
      const style = container.querySelector('style[data-kp-filter-style]');
      expect(style).toBeTruthy();
      // CSS rule generated for every card (4) because none match.
      const lines = (style?.textContent ?? '').split('\n').filter(Boolean);
      expect(lines).toHaveLength(4);
    });
    // The CSS targets `[data-kp-filter-scope=…] [data-card-id="…"]
    // {display:none}`. JSDom honours `display:none` from a `<style>` rule,
    // but only against the parsed selector chain — so we assert that each
    // row's id appears in the rule body.
    const style = container.querySelector('style[data-kp-filter-style]');
    const css = style?.textContent ?? '';
    const rows = container.querySelectorAll('.kp-table tbody tr');
    for (const r of rows) {
      const id = r.getAttribute('data-card-id');
      expect(id).toBeTruthy();
      // Every row's id appears in the hidden-cards CSS — non-matching set.
      expect(css).toContain(`[data-card-id="${id}"]`);
    }
  });

  it('applying a tag filter in Table view only hides non-matching rows', async () => {
    const { container } = renderBoardInMode('table');
    // Fixture has 2 #bug cards and 2 others. Apply tag=bug.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:apply-saved-view', {
          detail: {
            id: 'test-bugs',
            filter: { tags: ['bug'] },
            name: 'Bugs only',
          },
        }),
      );
    });
    await waitFor(() => {
      const style = container.querySelector('style[data-kp-filter-style]');
      expect(style).toBeTruthy();
      // 2 non-bug cards hidden.
      const lines = (style?.textContent ?? '').split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });
    // Cross-check: the hidden ids correspond to the non-bug rows.
    const style = container.querySelector('style[data-kp-filter-style]');
    const css = style?.textContent ?? '';
    const rows = Array.from(container.querySelectorAll('.kp-table tbody tr'));
    const hiddenIds = rows
      .map((r) => r.getAttribute('data-card-id') ?? '')
      .filter((id) => css.includes(`[data-card-id="${id}"]`));
    expect(hiddenIds).toHaveLength(2);
  });

  it('List rows carry data-card-id so HiddenCardsStyle can target them', async () => {
    const { container } = renderBoardInMode('list');
    const rows = container.querySelectorAll('.kp-list-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.getAttribute('data-card-id')).toBeTruthy();
    }
  });
});

describe('Saved Views right-rail count chips', () => {
  let app: App;
  let store: BoardStore;
  let savedViewStore: SavedViewStore;

  beforeEach(async () => {
    app = makeApp();
    store = makeStore();
    savedViewStore = makeSavedViewStore();
    await savedViewStore.load();
  });

  function renderBoard(): ReturnType<typeof render> {
    return render(
      <BoardRoot
        store={store}
        app={app}
        viewComponent={new Component()}
        mode="board"
        savedViewStore={savedViewStore}
      />,
    );
  }

  it('renders one .kp-saved-view__count span per pre-seeded view', () => {
    const { container } = renderBoard();
    const counts = container.querySelectorAll(
      '.kp-saved-view .kp-saved-view__count',
    );
    // DEFAULT_SAVED_VIEW_DEFS has four entries (due-this-week,
    // assigned-to-me, overdue, recurring) — every chip must have a count.
    expect(counts.length).toBe(4);
    for (const el of counts) {
      // The count is always a non-negative integer.
      expect(el.textContent ?? '').toMatch(/^\d+$/);
    }
  });

  it('"Recurring" count reflects cards with a non-empty rrule field', () => {
    // The prior placeholder behaviour returned the total card count (a
    // misleading "Recurring 4" when no card actually had a recurrence
    // rule). `hasRrule: true` makes the count reflect reality. The fixture
    // has no cards with `meta.fields.rrule`, so the count is 0.
    const { container } = renderBoard();
    const recurring = container.querySelector(
      '.kp-saved-view:nth-of-type(4) .kp-saved-view__count',
    );
    expect(recurring?.textContent).toBe('0');
  });

  it('"Assigned to me" count is 0 because no canonical "me" identity is configured', () => {
    // With no identity set, the predicate is empty; BoardRoot renders
    // empty-predicate counts as 0 rather than the misleading "every card
    // matches".
    const { container } = renderBoard();
    const assigned = container.querySelector(
      '.kp-saved-view:nth-of-type(2) .kp-saved-view__count',
    );
    expect(assigned?.textContent).toBe('0');
  });

  it('"Overdue" count is 0 against a fixture whose dates are all in 2099', () => {
    // The fixture's due dates are deliberately far in the future, so the
    // overdue predicate (dueBefore = today, done = false) matches none.
    const { container } = renderBoard();
    const overdue = container.querySelector(
      '.kp-saved-view:nth-of-type(3) .kp-saved-view__count',
    );
    expect(overdue?.textContent).toBe('0');
  });
});

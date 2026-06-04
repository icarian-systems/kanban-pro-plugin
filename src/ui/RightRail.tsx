/**
 * RightRail — the optional right-side companion column that sits inside
 * the leaf's `.view-content` (NOT in Obsidian's host sidebar; we don't
 * try to inject into the workspace right pane).
 *
 * Sections:
 *   - Smart Views (Pro) — built-in 4 filters: Due this week, Assigned to me,
 *                         Overdue, Recurring. (User-created "Saved Views" live
 *                         in the toolbar popover — different concept.) Free
 *                         users get a small upsell.
 *   - Active Timer (Pro) — read from the optional TrackingStore on context.
 *   - Linked Notes (Free) — backlinks resolved via `app.metadataCache`.
 *   - Integrations (Pro) — GitHub + Calendar status pills (Roadmap stub).
 *
 * The rail collapses at narrow widths via CSS (`@media (max-width: 1100px)`).
 * It does not subscribe to `state.board`; the only board-aware piece is
 * Linked Notes which derives off the source path + metadataCache.
 */
import * as React from 'react';
import type { App, TFile } from 'obsidian';
import { useProGate } from '@/pro/license/state';
import { PaywallCard } from '@/ui/PaywallCard';
import { useTrackingStore } from '@/ui/CardTrackingChip';
import { formatDuration, type TimerEntry } from '@/ui/contracts';
import {
  DEFAULT_SAVED_VIEW_DEFS,
  resolveDefaultSavedViewFilter,
} from '@/ui/savedViewsDefaults';
import { PRO_FEATURES_SENTENCE } from '@/shared/proCopy';

export interface RightRailProps {
  app?: App;
  /** Vault-relative path of the source board file — used to compute backlinks. */
  sourcePath?: string;
  /**
   * Map of pre-seeded saved-view id → number of cards currently matching its
   * filter. Computed by `BoardRoot` against the live board store (no
   * subscription is taken inside the rail itself — see the file header).
   * When undefined the count chips are simply not rendered, so the rail
   * remains usable even before counts are wired (graceful degradation in
   * embeds and tests).
   */
  savedViewCounts?: Readonly<Record<string, number>>;
  /**
   * Id of the saved view currently active on the board. The rail uses
   * this to render the matching chip in its `is-active` state and to
   * dispatch the toggle-off event when the user clicks it again
   * (toggle-off semantics).
   */
  activeSavedViewId?: string | null;
}

// ─── icons ──────────────────────────────────────────────────────────────
const CalIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <rect x="2" y="3" width="10" height="9" rx="0.6" />
    <path d="M2 6h10M5 1.5v3M9 1.5v3" />
  </svg>
);
const UserIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <circle cx="7" cy="5" r="2.4" />
    <path d="M3 12c0-2.2 1.8-4 4-4s4 1.8 4 4" />
  </svg>
);
const AlertIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M7 4.5v3M7 9v0.5" />
  </svg>
);
const RecurIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <path d="M3 7a4 4 0 0 1 7-2.5L11 6m0-3v3h-3M11 7a4 4 0 0 1-7 2.5L3 8m0 3v-3h3" />
  </svg>
);
const LinkIcon: React.FC = () => (
  <svg className="kp-lk-ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <path d="M3 7h3M8 7h3" />
    <path d="M5.5 5l3 4M4 9a2 2 0 1 1 0-4M10 5a2 2 0 1 1 0 4" />
  </svg>
);

// ─── Saved Views ────────────────────────────────────────────────────────

const SAVED_VIEW_EVENT = 'kanban-pro:apply-saved-view';

/**
 * Icon mapping for the pre-seeded views. Defined as a lookup table keyed
 * off `DEFAULT_SAVED_VIEW_DEFS.id` so the labels + ids stay in the shared
 * `savedViewsDefaults` module (BoardRoot's listener reads from there
 * too) and we only own the visual choice here.
 */
const VIEW_ICONS: Record<string, React.ReactNode> = {
  'due-this-week': <CalIcon />,
  'assigned-to-me': <UserIcon />,
  'overdue': <AlertIcon />,
  'recurring': <RecurIcon />,
};

/**
 * Pro-only — the section only renders for Pro users. The Free-tier upsell
 * for this and the other Pro rail sections is collapsed into a single
 * `<ExploreProSection />` at the bottom of the rail (L1).
 *
 * Each chip dispatches `kanban-pro:apply-saved-view` with the predicate
 * resolved at click-time (so "Due this week" uses today's date, not the
 * bundle build date). BoardRoot's listener picks it up and commits it to
 * the visible-filter state — same channel the user-saved picker rows use.
 * Clicking the currently-active chip dispatches `id: null` so BoardRoot
 * clears the filter (toggle-off semantics).
 */
const SavedViewsSection: React.FC<{
  counts?: Readonly<Record<string, number>>;
  activeSavedViewId?: string | null;
}> = ({ counts, activeSavedViewId }) => {
  const handleClick = React.useCallback((id: string, label: string) => {
    if (activeSavedViewId === id) {
      // Toggle off — clear the filter back to "Filter · all".
      window.dispatchEvent(
        new CustomEvent(SAVED_VIEW_EVENT, { detail: { id: null } }),
      );
      return;
    }
    const def = DEFAULT_SAVED_VIEW_DEFS.find((d) => d.id === id);
    const filter = def ? resolveDefaultSavedViewFilter(def) : {};
    window.dispatchEvent(
      new CustomEvent(SAVED_VIEW_EVENT, { detail: { id, filter, name: label } }),
    );
  }, [activeSavedViewId]);
  return (
    <section className="kp-rail-section">
      {/* "Smart Views" — these are the built-in, always-available filters
          (Due this week, Overdue, …). Deliberately NOT "Saved Views": that
          name belongs to the toolbar popover for USER-created saved filters.
          Two different concepts; same name was confusing (P5). */}
      <div className="kp-rail-h">Smart Views</div>
      {DEFAULT_SAVED_VIEW_DEFS.map((v) => {
        // The right rail shows a count next to each
        // saved-view entry, rendered as a `<span class="ct">N</span>`.
        // Counts are computed once per board
        // mutation by BoardRoot (same fingerprint used for the table-view
        // hidden-cards selector) and passed in via `counts`. We accept
        // `undefined` for chips whose id has no count yet (e.g. a future
        // default view added before the parent rolls out the count) so the
        // chip stays usable rather than rendering `NaN`.
        const count = counts?.[v.id];
        const isActive = activeSavedViewId === v.id;
        const countLabel =
          typeof count === 'number'
            ? `, ${count} card${count === 1 ? '' : 's'}`
            : '';
        return (
          <button
            key={v.id}
            type="button"
            className={`kp-saved-view${isActive ? ' is-active' : ''}`}
            onClick={() => handleClick(v.id, v.label)}
            aria-pressed={isActive}
            aria-label={`${v.label}${countLabel}${isActive ? ', active' : ''}`}
          >
            {VIEW_ICONS[v.id]}
            <span className="kp-saved-view__label">{v.label}</span>
            {typeof count === 'number' ? (
              <span className="kp-saved-view__count" aria-hidden="true">
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </section>
  );
};

// ─── Active Timer ───────────────────────────────────────────────────────

function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m 0s';
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function fmtStartedAt(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Pro-only — only mounts when the rail is rendered for a Pro user.
 * The Free-tier upsell is collapsed into the shared `<ExploreProSection />`.
 */
const ActiveTimerSection: React.FC = () => {
  const store = useTrackingStore();
  // Tick once per minute so the elapsed label stays close to wall-clock.
  // (Mirrors the discipline in `CardTrackingChip`: no setInterval — debounced
  // setTimeout aligned to the minute boundary.)
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!store) return;
    let cancelled = false;
    const schedule = (): (() => void) => {
      const now = Date.now();
      const next = 60_000 - (now % 60_000);
      const id = window.setTimeout(() => {
        if (cancelled) return;
        setTick((t) => t + 1);
        schedule();
      }, Math.max(1_000, next));
      return () => window.clearTimeout(id);
    };
    const stop1 = schedule();
    const stop2 = store.onChange(() => setTick((t) => t + 1));
    return () => { cancelled = true; stop1(); stop2(); };
  }, [store]);

  // Pro user — find a single running timer across known cards. The store
  // doesn't expose an enumeration API today, so we expose an empty state if
  // there's no convenient way to introspect. When the store contract is
  // extended with `getActive(): TimerEntry | undefined` we'll swap this in.
  const active = pickActiveTimer(store);

  return (
    <section className="kp-rail-section">
      <div className="kp-rail-h">Active Timer</div>
      {active ? (
        <div className="kp-timer-card">
          <div className="kp-timer-card__title">{active.title || 'Untitled card'}</div>
          <div className="kp-timer-card__sub">
            Started {fmtStartedAt(Date.parse(active.entry.startedAt))} · elapsed{' '}
            <strong>{fmtClock(Date.now() - Date.parse(active.entry.startedAt))}</strong>
            {active.todayMs > 0 ? <> · today {formatDuration(active.todayMs)}</> : null}
          </div>
          <div className="kp-timer-card__actions">
            <button
              type="button"
              className="kp-timer-card__btn is-primary"
              onClick={() => void store?.stop(active.entry.cardId)}
              aria-label="Stop timer"
            >
              Stop
            </button>
            <button
              type="button"
              className="kp-timer-card__btn"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('kanban-pro:open-tracking-panel', {
                    detail: { cardId: active.entry.cardId },
                  }),
                );
              }}
              aria-label="Open tracking details"
            >
              Details
            </button>
          </div>
        </div>
      ) : (
        <div className="kp-timer-card kp-timer-card--empty">
          <div className="kp-timer-card__title">No active timer</div>
          <div className="kp-timer-card__sub">Tap the timer pill on a card to start tracking.</div>
        </div>
      )}
    </section>
  );
};

/**
 * Find any single running timer the tracking store knows about. We probe the
 * store cautiously: today there's no enumeration API on `TrackingStore`, so
 * we return undefined unless a future contract extension exposes one. When
 * the store surfaces an enumerator, this function picks it up via duck
 * type without a type change rippling through the UI.
 */
function pickActiveTimer(
  store: ReturnType<typeof useTrackingStore>,
): { entry: TimerEntry; title: string; todayMs: number } | null {
  if (!store) return null;
  const probe = store as unknown as {
    getActive?: () => TimerEntry | undefined;
    listActive?: () => TimerEntry[];
    todayMs?: (cardId: string) => number;
  };
  let entry: TimerEntry | undefined;
  if (typeof probe.getActive === 'function') entry = probe.getActive();
  else if (typeof probe.listActive === 'function') entry = probe.listActive()[0];
  if (!entry) return null;
  const todayMs = typeof probe.todayMs === 'function'
    ? probe.todayMs(entry.cardId) - (Date.now() - Date.parse(entry.startedAt))
    : 0;
  return { entry, title: entry.note ?? '', todayMs: Math.max(0, todayMs) };
}

// ─── Linked Notes ───────────────────────────────────────────────────────

const LinkedNotesSection: React.FC<{ app?: App; sourcePath?: string }> = ({ app, sourcePath }) => {
  const links = React.useMemo(() => {
    if (!app || !sourcePath) return [] as string[];
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!file) return [];
    const md = app.metadataCache as unknown as {
      getBacklinksForFile?: (f: TFile) => { data: Record<string, unknown> };
      resolvedLinks?: Record<string, Record<string, number>>;
    };
    // Newer Obsidian — direct API.
    if (typeof md.getBacklinksForFile === 'function') {
      const res = md.getBacklinksForFile(file as TFile);
      const data = res?.data ?? {};
      return Object.keys(data);
    }
    // Older Obsidian — scan resolvedLinks for any source whose target is us.
    const resolved = md.resolvedLinks ?? {};
    const out: string[] = [];
    for (const source in resolved) {
      if (resolved[source]?.[sourcePath]) out.push(source);
    }
    return out;
  }, [app, sourcePath]);

  const openLink = React.useCallback((path: string) => {
    if (!app) return;
    void app.workspace.openLinkText(path, '', false);
  }, [app]);

  return (
    <section className="kp-rail-section">
      <div className="kp-rail-h">Linked Notes</div>
      {links.length === 0 ? (
        <div className="kp-rail-empty">No backlinks yet.</div>
      ) : (
        links.slice(0, 6).map((path) => {
          const basename = path.replace(/^.*\//, '').replace(/\.md$/i, '');
          return (
            <button
              key={path}
              type="button"
              className="kp-backlink"
              onClick={() => openLink(path)}
              title={path}
            >
              <LinkIcon />
              <span className="kp-backlink__label">{basename}</span>
            </button>
          );
        })
      )}
    </section>
  );
};

// ─── Explore Pro (single consolidated upsell for Free users) ────────────

/**
 * L1 — one calm "Explore Pro" card replaces the three separate per-feature
 * paywall cards we used to stack in the rail for Free users. Reads less
 * like nag-ware and gives a single, honest pitch for the bundle.
 *
 * Sits at the bottom of the rail so the Free-useful section (Linked Notes)
 * stays above the fold.
 */
const ExploreProSection: React.FC = () => (
  <section className="kp-rail-section">
    <div className="kp-rail-h">Explore Pro</div>
    <PaywallCard
      feature="Kanban Pro"
      description={PRO_FEATURES_SENTENCE}
      ctaLabel="Activate"
      compact
      layout="stack"
    />
  </section>
);

// ─── shell ──────────────────────────────────────────────────────────────

export const RightRail: React.FC<RightRailProps> = ({ app, sourcePath, savedViewCounts, activeSavedViewId }) => {
  const gate = useProGate();
  const isPro = gate.tier === 'pro';

  // L1 — Free users see Linked Notes + a single "Explore Pro" upsell.
  // Pro users see Saved Views, Active Timer, and Linked Notes. (The old
  // "Integrations" section was removed for 1.0 — it only ever rendered
  // hardcoded "pending" status dots that tracked no real state; calendar
  // export is an on-demand action via the command palette / settings, not a
  // live sync, and GitHub is a post-1.0 roadmap item.)
  return (
    <aside className="kp-rail" aria-label="Board side panel">
      {isPro ? (
        <>
          <SavedViewsSection counts={savedViewCounts} activeSavedViewId={activeSavedViewId} />
          <ActiveTimerSection />
          <LinkedNotesSection app={app} sourcePath={sourcePath} />
        </>
      ) : (
        <>
          <LinkedNotesSection app={app} sourcePath={sourcePath} />
          <ExploreProSection />
        </>
      )}
    </aside>
  );
};

# Changelog

All notable changes to Kanban Pro are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.9] — 2026-06-03

Completes the "+ Add card" fix. 1.0.8 made the new card render; this release
stops it from disappearing a moment later.

### Fixed

- **A newly added card no longer vanishes ~600ms after it appears.** An empty
  placeholder card serializes to nothing, so it does not survive a
  serialize→parse round-trip. When the debounced save flushed, Obsidian
  re-fired `setViewData` with the plugin's own bytes; the self-write branch
  ran `applyDiskSnapshot` → `parseBoard` (zero cards) → `setBoard`, deleting
  the just-created card out from under the user's open inline editor. The
  self-write branch now treats a byte-identical echo as a no-op (mirroring the
  `onVaultModify` path) and leaves the in-memory board — including the
  transient placeholder — untouched. Combined with the 1.0.8 visibility fix,
  "+ Add card" now reliably opens an editable card that stays put.

### Internal

- Removed a dangling `react-hooks/exhaustive-deps` eslint-disable directive in
  `Card.tsx` that referenced an unregistered rule and was failing `npm run
  lint` (and therefore CI) since 1.0.7.

## [1.0.8] — 2026-06-03

Follow-up patch to the 1.0.6/1.0.7 "+ Add card" fixes. The earlier patches
chased an inline-editor focus race; the real cause was that the new card was
hidden by `display:none` before focus could ever matter.

### Fixed

- **"+ Add card" on a board with empty placeholders no longer creates
  invisible cards.** The board-level filter-visibility CSS (`HiddenCardsStyle`)
  hides any card present in `totalCardIds` but absent from `visibleCardIds`.
  `visibleCardIds` was derived from `applyFilter`, which excludes empty
  placeholder cards — *even when no filter is active*. So the instant
  "+ Add card" created an empty placeholder, the board injected
  `[data-card-id="…"]{display:none !important}` for it: the card existed and
  bumped the lane count, but was invisible. Being `display:none`, it could not
  take editor focus or fire its discard-on-blur, so empty placeholders silently
  piled up (the lane chip climbing "8", "9"… over an empty-looking lane).
  Placeholder cards are now always included in the visibility set — they are
  transient edit targets with no content to match a filter yet — while
  saved-view and masthead counts remain content-only.

## [1.0.7] — 2026-06-03

Follow-up patch to the 1.0.6 "+ Add card" fix.

### Fixed

- **"+ Add card" reliably opens the inline editor on the new card.** The
  previous fix still depended on a `kanban-pro:focus-new-card` window event
  dispatched via `setTimeout(0)` from the click handler. Because Column
  re-renders synchronously (via `useSyncExternalStore`) but the new card's
  `useEffect` listener registers only after paint, the event fired before any
  listener existed and was lost — so the new card stayed blank and looked
  invisible. The creation intent is now passed to the card as an
  `autoFocusOnMount` prop, evaluated synchronously at render time, so the
  card's mount effect opens the editor every time.

## [1.0.6] — 2026-06-03

First-time-user QA pass. No new features — this release makes existing
(advertised) features actually work and removes a pervasive interruption.

### Fixed

- **Welcome modal no longer re-appears on every edit.** The first-run
  onboarding modal was wired to the metadata-cache `resolved` event, which
  fires after *every* board write (create board, add card, drag, toggle a
  checkbox, rename a lane), so it popped up again after almost any action.
  It now auto-opens at most once per install: the listener is detached after
  its first fire and gated on a persisted `hasSeenOnboarding` flag.
- **"+ Add card" works again.** With the modal no longer stealing focus from
  the inline editor mid-add, adding a card no longer commits a blank,
  invisible placeholder.
- **Time tracking is reachable.** A plugin-registry lookup used the wrong id
  (`kanban-pro` instead of the manifest id `kanban-pro-boards`), so the
  tracking store resolved to `null` and the timer pill never rendered. The
  pill now appears on cards, and long-press / the right-rail "Details" button
  open the time-tracking history drawer (which was never mounted).
- **Calendar (.ics) export produces output.** Export only recognised the
  `@{date}` form and skipped cards dated with `[due:: …]` or `📅`, so boards
  full of dated cards exported an empty calendar. It now resolves every
  due-date syntax and shows a clear notice when a board has no dated cards.
- **Toolbar "Dashboard" button opens the Dashboard.** It dispatched a command
  whose id used the wrong prefix and swallowed the failure; the open is now
  handled directly by the plugin.
- **Pro CTAs land on the Pro settings pane**, not General.
- **Saved Views popover reliably reopens** (the trigger click no longer races
  the outside-click close), so custom filters can be saved as named views.
- **Recurrence field keeps spaces.** Typing "every Monday" no longer collapses
  to "everyMonday".

### Changed

- **Right-rail built-in filters renamed "Smart Views"** to disambiguate them
  from the toolbar's user-created "Saved Views".
- **Pro feature list unified** across the onboarding modal, the right-rail
  upsell, and the Pro settings pane (and the contradictory "Free is fully
  featured" line was reworded).
- **Card details paywall no longer clips** at the panel's right edge.
- **Lane and board counts respect the active filter** (e.g. "2 of 4") instead
  of showing unfiltered totals above a narrowed board.

## [1.0.5] — 2026-06-03

### Changed

- **README rewritten for Obsidian users.** The README is now user-facing —
  install-from-Obsidian steps, a getting-started walkthrough, an inline-metadata
  syntax reference, a commands table, a settings tour, and the five
  `docs/*.png` screenshots. All developer content (build, watch loop, test
  table, project layout, licensing internals) moved to a new
  [CONTRIBUTING.md](CONTRIBUTING.md). Also corrected the sandbox plugin-folder
  path to the real id `kanban-pro-boards`.

## [1.0.4] — 2026-06-03

### Fixed (plugin-review warnings)

- **`!important` removed from the reduced-motion reset.** Motion is now
  neutralized by collapsing the `--kp-duration-*` tokens inside the
  `prefers-reduced-motion` media query (the reviewer-recommended
  CSS-variables route), so every `var(--kp-duration-*)`-based animation and
  transition resolves to ~0 without fighting specificity. The handful of
  looping affordances that use hard-coded durations (spinner, skeleton
  shimmer, timer / tracking / drop-indicator pulses) are stopped with
  explicit `animation: none` rules whose selectors mirror the originals —
  a11y.css loads last, so equal specificity + source order wins.
  `styles.css` now contains zero `!important` declarations.
  ([src/styles/a11y.css](src/styles/a11y.css))
- **README title now matches `manifest.json`.** The H1 and opening blurb
  read "Kanban for Professionals" to match the manifest `name`.

## [1.0.3] — 2026-06-03

### Changed

- **Display name finalized to "Kanban for Professionals."** The Obsidian
  directory rejected the previous name (`Kanban Pro for the professional`)
  and the automated review flagged a repo/release manifest mismatch. The
  manifest `name`, the repository root, and the release-asset `manifest.json`
  now all agree on a single, directory-compliant name. The plugin `id`
  stays `kanban-pro-boards` (unchanged).

### Fixed (plugin-review warnings)

- **`builtin-modules` dependency removed.** The esbuild config now derives
  the Node built-in externals list from the native `node:module`
  `builtinModules` export (plus `node:`-prefixed aliases), dropping the
  third-party package the review flagged. ([esbuild.config.mjs](esbuild.config.mjs))
- **CSS — partially-supported features removed.** Dropped the standard
  `scrollbar-color` (the existing `::-webkit-scrollbar` rules already
  style the scrollbar on Obsidian's Chromium), the `ui-monospace` literal
  in the rail count chip (now resolves through `--kp-font-mono`), and the
  `text-decoration-color` / `text-decoration-thickness` longhands across
  card, table, list, and paywall styles (base `underline` / `line-through`
  retained).
- **CSS — `!important` removed from editor overrides.** The inline editor
  and detail-panel CM6 background/padding overrides now win through a
  specificity bump (`.cm-editor.cm-editor`) instead of `!important`. The
  reduced-motion reset in `a11y.css` deliberately keeps `!important` — it
  is the correct, required tool for an accessibility override that must
  beat arbitrary per-component animations.

## [1.0.2] — 2026-06-03

### Changed

- **Plugin `id` renamed to `kanban-pro-boards`.** The previous `kanban-pro`
  id was already claimed in Obsidian's submission registry, blocking the
  community-plugin listing. The cache path now derives from
  `configDir` + `manifest.id` at runtime
  ([src/core/vaultIndex/index.ts](src/core/vaultIndex/index.ts)) so the
  on-disk index always follows the real install folder.
- **Display name** updated (superseded by 1.0.3 — see above).

## [1.0.1] — 2026-05-18

### Fixed

- **A5 / Journey 8 — Foreign-write banner now renders.** External edits to
  the open board (Obsidian Sync, another editor, a CLI) route through the
  read-only banner + recovery diff instead of being absorbed silently. The
  fix tracks the last-known serialized board on the session so the D2
  false-positive guard can't misclassify a foreign write as an idempotent
  echo when `setViewData` lands before the debounced modify handler.
  ([src/view/KanbanView.tsx](src/view/KanbanView.tsx))
- **B3 — Saved-view and explicit-filter predicates are now consistent
  across Board, Table, List, Dashboard, and the right rail.** A single
  `filterCards(board, filter, ctx)` engine in
  [src/pro/savedViews/filter.ts](src/pro/savedViews/filter.ts) is the
  source of truth; the rail dispatches saved-view events that
  BoardRoot's `FilterContext` translates into a concrete `ViewFilter`,
  and TableRoot / ListRoot rows now emit `data-card-id` so the CSS-
  injected filter scope applies there too.
- **C-10 — Escape now reverts the lane-rename input.** The keystroke
  handler moved off React's synthetic-event delegation to a native
  capture-phase listener on the input (and a guarded window-capture
  fallback), so Obsidian's workspace-level capture listeners can no
  longer preempt the cancel keystroke.
- **W2.1 / C-4 / C-5 / C-6 — Inline-meta tokens are stripped from
  rendered card titles** in Board, Table, and List views. The Dataview
  field, block-id, hashtag, and Tasks-plugin emoji tokens render only as
  chips below the title; the raw token text is no longer duplicated
  in the title row. ([src/core/parser/inlineMeta.ts:stripInlineMetaTokens](src/core/parser/inlineMeta.ts))
- **W2.4 / C-9 — Horizontal scrollbar is always visible** on a 4-plus-
  lane board (`scrollbar-gutter: stable`). Webkit-specific scrollbar
  styling renders a slim, themed track on macOS.
- **W2.6 — Filter popover now layers above the Table view's sticky
  header.** The subnav establishes a `--kp-z-popover` stacking
  context so its inner panel can't be eclipsed by sibling sticky
  content.
- **W2.7 — Empty placeholder cards are excluded from saved-view counts.**
  Adding a card no longer flickers the rail counts to `1` before any
  content is typed.
- **W2.8 — Dashboard `Overdue` / `Due 7d` counters now respect
  emoji-style `📅 YYYY-MM-DD` and Dataview-style `[due:: …]` dates.**
  Card chip rendering, filter predicates, and the vault index all
  consume a shared `cardDue(card)` helper.
  ([src/core/model.ts](src/core/model.ts))
- **W3.4 — Foreign write during in-flight save** correctly engages the
  recovery diff (was silently absorbed). New regression test.
- **W4.5 — ErrorBoundary now emits structured crash records** with
  label, name, message, stack, componentStack, and an ISO timestamp,
  plus a `kanban-pro:error-boundary-caught` window event for telemetry.

### Added

- `ViewFilter.hasRrule` — match cards by presence/absence of an inline
  `[rrule:: …]` recurrence rule.
- `materializeSavedView(key, ctx)` and `SAVED_VIEW_KEYS` — convert a
  built-in saved-view identifier into a concrete filter spec, with a
  `null` return when the user has not configured the required context
  (e.g. `assigned-to-me` with no identity).
- `cardDue(card)` — normalize across `@{date}`, emoji `📅`, and
  `[due:: …]` syntaxes for every due-date consumer.
- `kp-saved-view__count` — numeric per-saved-view count rendered in
  the right rail.
- `Add lane` affordance gets a visible `+` glyph plus a `title`
  attribute (W2.3).
- `recurrence-rrule.md` round-trip fixture asserts the migration
  guarantee on cards carrying `[rrule:: FREQ=…]` tokens.
- 36 new tests across the filter engine, foreign-write banner,
  Column rename, recurrence round-trip, vault-index emoji-date
  normalization, license Grace state, and inline-meta token
  stripping. Suite total: 221 → 259.

### Changed

- **`manifest.json` version 1.0.0 → 1.0.1.** Note that Obsidian's plugin
  manager caches the manifest version; toggle the plugin off/on or
  restart Obsidian to refresh the displayed version in Settings.
- `versions.json` adds `"1.0.1": "1.6.0"` so the installer picks the
  correct minAppVersion on first install of 1.0.1.
- `package.json` `overrides` pins `@codemirror/state`, `@codemirror/view`,
  `@codemirror/commands` so the CM6 mount path can't fall back to the
  textarea via the "multiple instances of @codemirror/state" warning.
  The `vitest.config.ts` `dedupe` array already covered the test path.
- `BoardRoot` now wraps its tree in a `FilterContext.Provider`; the
  rail, subnav, and view-mode trees all consume the same filter
  state. Saved-view rail clicks dispatch a `kanban-pro:apply-saved-view`
  event; BoardRoot owns the handler.
- `kp-popover` now uses `var(--kp-z-popover)` instead of the literal
  `z-index: 50`, and `.kp-subnav` establishes a stacking context to
  keep its absolutely-positioned descendants above the Table view's
  sticky `<thead>`.

### Known limitations (carried into 1.0.1)

- **Mobile (Journey 7) — not exercised this pass.** The `body.is-mobile`
  overrides have unit coverage via `src/__tests__/mobile/dndSmoke.test.tsx`
  but no real-device QA was possible. Track as a 1.0.2 priority.
- **Production license server** — Kanban Pro 1.0.1 ships with the
  dev license server at `/tmp/kanban-pro-license-dev/`. Cloudflare
  key custody, paid-customer signing, and revocation feed deployment
  are roadmap for 1.1 and remain out of release scope.
- **Status-bar disconnect icon** noted in the QA 2026-05-17 report
  originates outside our plugin (most likely Obsidian Sync's own
  connectivity indicator). Nothing to hide on our side.

## [1.0.0] — 2026-05-13

Initial release. Drop-in compatibility with `kanban-plugin: board`
files; Free-tier Board/Table/List views, drag-and-drop, undo, embeds;
Pro-tier Saved Views, recurrence, Dashboard, integrations.

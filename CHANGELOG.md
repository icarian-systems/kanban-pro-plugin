# Changelog

All notable changes to Kanban Pro are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.2] — 2026-06-03

### Changed

- **Plugin `id` renamed to `kanban-pro-boards`.** The previous `kanban-pro`
  id was already claimed in Obsidian's submission registry, blocking the
  community-plugin listing. The cache path now derives from
  `configDir` + `manifest.id` at runtime
  ([src/core/vaultIndex/index.ts](src/core/vaultIndex/index.ts)) so the
  on-disk index always follows the real install folder.
- **Display name** updated to "Kanban Pro, for the professional".

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

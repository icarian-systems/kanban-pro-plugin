/**
 * Starter board content — the "Welcome to Kanban Pro" file the onboarding
 * modal creates on first run when the user picks "Create starter board".
 *
 * The cards are written so the user is steered toward the headline
 * gesture (dragging a card between lanes) within seconds of opening the
 * file. No inline metadata, no tags, no dates: every demonstrated
 * mechanic must work on the free tier.
 *
 * Contract: `renderStarterBoardMarkdown()` MUST round-trip through
 * `parseBoard` → `serializeBoard` with byte-equal output. The `validate
 * board` command (main.ts) is the user-visible enforcement; the
 * `starterBoard.roundtrip.test.ts` test is the CI gate. If you edit the
 * template, run the test before shipping.
 */
import { renderSettingsBlock } from '@/core/parser/settingsBlock';

/**
 * Vault-root filename for the starter board (without the `.md` suffix).
 * Distinct from `Untitled Board` so it's recognizable in the file
 * explorer — the filename itself is part of the welcome.
 */
export const STARTER_BOARD_BASENAME = 'Welcome to Kanban Pro';

/**
 * Build the canonical starter-board markdown.
 *
 * Cards intentionally avoid:
 *  - Inline metadata tokens (`@start`, `[k:: v]`, `#tag`, emoji prefixes)
 *  - Right-arrow `←` (Backlog is leftmost; the user drags right)
 *  - Platform-specific chords (`⌘Z`); `Cmd+Z` reads on macOS and Windows.
 *
 * The settings block is emitted via `renderSettingsBlock(...)` so the
 * canonical fence + comment shape comes from the parser package, not a
 * hand-rolled string — this is what guarantees zero byte-diff under
 * `validate-board`.
 */
export function renderStarterBoardMarkdown(): string {
  return [
    '---',
    'kanban-plugin: board',
    '---',
    '',
    '## Backlog',
    '',
    '- [ ] Click me to edit',
    '- [ ] Drag me to "In Progress" →',
    '- [ ] Use Cmd+Z to undo any drag',
    '',
    '## In Progress',
    '',
    '- [ ] Rename me by clicking the card title',
    '',
    '## Done',
    '',
    '- [x] You finished onboarding',
    '',
    renderSettingsBlock({ 'kanban-plugin': 'board' }),
  ].join('\n');
}

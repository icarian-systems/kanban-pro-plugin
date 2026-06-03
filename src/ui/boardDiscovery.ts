/**
 * Shared kanban-format file discovery.
 *
 * Both the "Open existing…" fuzzy picker and the onboarding migrator
 * detection need to enumerate every `.md` file whose frontmatter declares
 * `kanban-plugin: board`. Keep that single-source-of-truth here so the
 * two call sites cannot drift.
 *
 * Reads from `metadataCache` (not file contents) — same source the
 * file-open routing hook in `main.ts` consults. The cache may be empty
 * on cold start; callers that need a complete result must wait for
 * `metadataCache.on('resolved', …)` before calling.
 */
import type { App, TFile } from 'obsidian';

export function listExistingBoards(app: App): TFile[] {
  const out: TFile[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    if (fm && fm['kanban-plugin'] === 'board') out.push(file);
  }
  return out;
}

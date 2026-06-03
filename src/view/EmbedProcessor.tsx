/**
 * EmbedProcessor — markdown post-processor that mounts a read-only
 * (or optionally interactive) BoardRoot inside a host Markdown note.
 *
 * This is the v1 fix for issue #4 (top-requested in the incumbent's
 * tracker): kanban boards embeddable in other notes / Canvas.
 *
 * Two trigger paths:
 *
 *   1. **Fenced code blocks** with the `kanban` or `kanban-pro`
 *      language tag whose body is a full board document.
 *
 *   2. **File embeds**: `![[Q2 Sprint]]` where the target file has
 *      `kanban-plugin: board` in its frontmatter. Obsidian fires the
 *      post-processor on the rendered embed; we detect the embed
 *      container, read the target file, parse, and mount.
 *
 * Embeds get their OWN isolated Zustand store — never share a store
 * with another view, even if the embed and the original view point at
 * the same file. (Otherwise an embed re-render storms the owning view.)
 *
 * Read-only by default. The host file's `allow-embed-edit: true` toggle
 * (defined per-board in its settings block) enables interactive DnD /
 * inline editing in the embed.
 */
import {
  MarkdownRenderChild,
  type MarkdownPostProcessorContext,
  type Plugin,
  TFile,
} from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import * as React from 'react';

import { parseBoard } from '@/core/parser';
import { BoardRoot } from '@/ui/BoardRoot';
import { createBoardStore, type BoardStore } from '@/core/store';
import { log } from '@/shared/log';

const EMBED_LANGS = ['kanban', 'kanban-pro'] as const;

export function registerEmbedProcessor(plugin: Plugin): void {
  // Code-block path: `registerMarkdownCodeBlockProcessor` is the
  // sanctioned API and fires before the post-processor, so the rendered
  // <pre><code> never flashes.
  for (const lang of EMBED_LANGS) {
    (plugin as unknown as {
      registerMarkdownCodeBlockProcessor: (
        lang: string,
        cb: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void,
      ) => void;
    }).registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => {
      mountEmbed(plugin, el, source, ctx.sourcePath, ctx);
    });
  }

  // File-embed path: `![[Q2 Sprint]]` where the target has
  // `kanban-plugin: board` frontmatter. The post-processor receives the
  // host note's DOM; we hydrate any internal-embed that points to a
  // board. Obsidian renders the embed's title + body asynchronously
  // *after* our post-processor returns — we install a MutationObserver
  // that re-mounts our content if Obsidian writes back over our DOM.
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    scanForEmbeds(plugin, el, ctx.sourcePath, ctx);
  });

  // In Live Preview mode the markdown post-processor does NOT
  // fire for inline `![[...]]` transclusions (Obsidian's CM6 pipeline
  // renders them via its own embed widget, bypassing our processor and
  // producing a "flat outline with leaked settings JSON"). Walk the
  // live document for any embed widget that
  // points at a board file and hydrate it the same way the
  // post-processor does. We re-scan on workspace `layout-change` and
  // `active-leaf-change` so a freshly-opened note picks up its embeds,
  // and again whenever the editor's DOM mutates (typing rebuilds the
  // widget tree).
  const livePreviewScan = (): void => {
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf?.view as unknown as
        | { containerEl?: HTMLElement; file?: TFile }
        | undefined;
      const root = view?.containerEl;
      if (!root) return;
      // Skip our own KanbanView containers — embeds inside a KanbanView
      // are out of scope and our own DOM lives here too.
      if (root.classList.contains('kanban-pro-mount')) return;
      const sourcePath = view?.file?.path ?? '';
      scanForEmbeds(plugin, root, sourcePath, null);
    });
  };

  // Defer initial scan to after the workspace has finished mounting.
  // (`onLayoutReady` is the documented hook; fall through to a microtask
  // for hosts that haven't typed it.)
  const workspaceWithReady = plugin.app.workspace as unknown as {
    onLayoutReady?: (cb: () => void) => void;
  };
  if (workspaceWithReady.onLayoutReady) {
    workspaceWithReady.onLayoutReady(livePreviewScan);
  } else {
    queueMicrotask(livePreviewScan);
  }

  plugin.registerEvent(
    plugin.app.workspace.on('layout-change', livePreviewScan),
  );
  plugin.registerEvent(
    plugin.app.workspace.on('active-leaf-change', livePreviewScan),
  );

  // A DOM observer at the document body level is the safety net for
  // edits-in-place: Live Preview tears down and rebuilds embed widgets
  // as the surrounding markdown changes, so a leaf-level event misses
  // them. Cheap childList observation is enough — we re-scan the
  // mutated subtree's nearest leaf container.
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      // Bail early if no element nodes were added (we only care about
      // newly-inserted embed widgets).
      let hadElementAdd = false;
      rec.addedNodes.forEach((n) => {
        if (n.nodeType === 1) hadElementAdd = true;
      });
      if (!hadElementAdd) continue;
      const target = rec.target as Element | null;
      if (!target) continue;
      // Look for embed widgets in or under the mutated node.
      const root =
        (target as Element).closest?.('.view-content, .markdown-source-view, .markdown-reading-view') ??
        target;
      if (!(root instanceof HTMLElement)) continue;
      // Cheap selector scan; mountEmbed itself is idempotent.
      const candidates = root.querySelectorAll<HTMLElement>(
        '.internal-embed[src], .markdown-embed[src], .cm-embed-block[src]',
      );
      if (candidates.length === 0) continue;
      // Resolve the source path from the leaf this DOM belongs to.
      const leafEl = root.closest('.workspace-leaf') as HTMLElement | null;
      let sourcePath = '';
      if (leafEl) {
        plugin.app.workspace.iterateAllLeaves((leaf) => {
          const v = leaf?.view as unknown as
            | { containerEl?: HTMLElement; file?: TFile }
            | undefined;
          if (v?.containerEl && leafEl.contains(v.containerEl)) {
            sourcePath = v.file?.path ?? '';
          }
        });
      }
      scanForEmbeds(plugin, root, sourcePath, null);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  plugin.register(() => observer.disconnect());
}

/**
 * Find every kanban file-embed widget under `root` and mount our isolated
 * BoardRoot in it. Idempotent — embed elements already marked
 * `data-kanban-pro-embed="mounted"` are skipped.
 *
 * Used by both code paths:
 *   - the `registerMarkdownPostProcessor` callback (Reading mode)
 *   - the Live Preview workspace observer (CM6 widget tree)
 */
function scanForEmbeds(
  plugin: Plugin,
  root: HTMLElement,
  sourcePath: string,
  ctx: MarkdownPostProcessorContext | null,
): void {
  // Match the wrapper Obsidian uses in either mode. `.cm-embed-block`
  // is the Live Preview wrapper; `.internal-embed` / `.markdown-embed`
  // are Reading mode.
  const fileEmbeds = root.querySelectorAll<HTMLElement>(
    '.internal-embed[src], .markdown-embed[src], .cm-embed-block[src]',
  );
  fileEmbeds.forEach((embedEl) => {
    const src = embedEl.getAttribute('src');
    if (!src) return;
    void hydrateFileEmbed(plugin, embedEl, src, sourcePath, ctx);
  });
}

async function hydrateFileEmbed(
  plugin: Plugin,
  embedEl: HTMLElement,
  src: string,
  sourcePath: string,
  ctx: MarkdownPostProcessorContext | null,
): Promise<void> {
  const target = plugin.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
  if (!target || !(target instanceof TFile)) return;
  const cache = plugin.app.metadataCache.getFileCache(target);
  const fm = cache?.frontmatter as Record<string, unknown> | undefined;
  if (!fm || fm['kanban-plugin'] !== 'board') return;

  // Skip if we've already taken over this embed (the MutationObserver
  // re-entry guard).
  if (embedEl.dataset.kanbanProEmbed === 'mounted') return;
  let text: string;
  try {
    text = await plugin.app.vault.cachedRead(target);
  } catch (err) {
    log.warn('embed: failed to read target file', err);
    return;
  }
  // Pass the *target* file's path (not the host note's) so the
  // embedded BoardRoot's masthead reads the source board's basename for
  // its title. Without this, a daily
  // note containing `![[Untitled Board]]` was showing "Daily Note" as
  // the embed title because we were forwarding `sourcePath` (the host
  // note's path) verbatim. The board's display name has to come from
  // the *embedded* file. Link resolution still uses the host path
  // upstream — only the rendered title cares about the target.
  mountEmbed(plugin, embedEl, text, target.path, ctx);
}

function mountEmbed(
  plugin: Plugin,
  hostEl: HTMLElement,
  source: string,
  sourcePath: string,
  ctx: MarkdownPostProcessorContext | null,
): void {
  // Idempotent re-entry guard. Live Preview's MutationObserver can
  // re-fire on every keystroke; without this, mountEmbed tears down
  // its own React tree on each pass.
  if (hostEl.dataset.kanbanProEmbed === 'mounted') return;

  const parsed = parseBoard(source);
  if (!parsed.board) {
    // Render a small notice in place of the board.
    clearChildren(hostEl);
    hostEl.dataset.kanbanProEmbed = 'mounted';
    const notice = document.createElement('div');
    notice.className = 'kanban-pro-embed-error';
    notice.textContent = 'Could not render embedded board: ' +
      (parsed.errors[0]?.message ?? 'unknown parse error');
    hostEl.appendChild(notice);
    return;
  }

  const allowEmbedEdit = parsed.board.settings['allow-embed-edit'] === true;

  // Isolated store per embed. Read-only by default; even with
  // allowEmbedEdit, writes from an embed must be a separate concern
  // (live-syncing edits back to the source file is a future-version
  // problem; v1 surfaces a "this is read-only because embed" indicator
  // in the UI).
  const store = createBoardStore({
    initialBoard: parsed.board,
    isEmbed: true,
    // onMutate intentionally unset — embeds in v1 don't write back.
  });

  // Replace host content with a fresh mount point. Mark the host so we
  // (a) recognise it on re-entry, and (b) can target CSS overrides to
  // suppress the empty-state title bar Obsidian renders by default.
  clearChildren(hostEl);
  hostEl.dataset.kanbanProEmbed = 'mounted';
  hostEl.classList.add('kanban-pro-embed-host');
  const mountPoint = document.createElement('div');
  mountPoint.className = 'kanban-pro-embed';
  hostEl.appendChild(mountPoint);

  const root = createRoot(mountPoint);

  // Obsidian populates `internal-embed` containers asynchronously —
  // after our post-processor returns, the host's own embed renderer can
  // walk the same node and overwrite our React tree with H2 headings +
  // the settings code block (this is the exact failure mode
  // observed). We install a MutationObserver that re-asserts our mount
  // if Obsidian writes back. The observer is detached when the
  // MarkdownRenderChild unloads.
  const observer = new MutationObserver(() => {
    // Cheap check: if our mountPoint is no longer a child, restore it.
    if (!hostEl.contains(mountPoint)) {
      clearChildren(hostEl);
      hostEl.appendChild(mountPoint);
    } else if (hostEl.firstChild !== mountPoint || hostEl.childElementCount > 1) {
      // Obsidian appended siblings (icon/title) — strip them, keep our
      // mountPoint as the sole child.
      for (let i = hostEl.childNodes.length - 1; i >= 0; i -= 1) {
        const child = hostEl.childNodes[i];
        if (child !== mountPoint) hostEl.removeChild(child);
      }
    }
  });
  observer.observe(hostEl, { childList: true });

  // Register teardown. When we have a MarkdownPostProcessorContext, route
  // through `ctx.addChild` so Obsidian disposes us when the host re-renders.
  // For the Live Preview path (no ctx), `plugin.addChild()` ties our
  // component lifetime to the plugin itself; load() / unload() still get
  // called by the host. Either way, our `onunload` tears down the React
  // tree, the MutationObserver, and the store.
  const child = new EmbedComponent(mountPoint, root, store, observer);
  if (ctx) {
    ctx.addChild(child);
  } else {
    (plugin as unknown as { addChild: (c: MarkdownRenderChild) => void }).addChild(child);
  }

  root.render(
    <BoardRoot
      store={store}
      app={plugin.app}
      viewComponent={child}
      sourcePath={sourcePath}
      mode={(parsed.board.settings['default-view'] as 'board' | 'table' | 'list') ?? 'board'}
      readOnly={true}
      allowEmbedEdit={allowEmbedEdit}
    />,
  );
}

function clearChildren(el: HTMLElement): void {
  // `el.empty()` is Obsidian's helper; not present in jsdom for tests, so
  // fall back to a manual loop. Either works at runtime.
  while (el.firstChild) el.removeChild(el.firstChild);
}

// Thin MarkdownRenderChild wrapper so addChild() can dispose the React
// root and the store when the host markdown re-renders. We extend
// MarkdownRenderChild (not Component) because ctx.addChild expects
// that subclass — it expects a `containerEl` on the child for
// targeting/re-render bookkeeping.
class EmbedComponent extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private root: Root,
    private store: BoardStore,
    private observer: MutationObserver,
  ) {
    super(containerEl);
  }
  onunload(): void {
    try {
      this.observer.disconnect();
    } catch (err) {
      log.warn('embed: observer disconnect failed', err);
    }
    try {
      this.root.unmount();
    } catch (err) {
      log.warn('embed: react unmount failed', err);
    }
    // Zustand stores have no explicit destroy in v5; clearing
    // subscribers happens naturally as React tears down.
    void this.store;
  }
}

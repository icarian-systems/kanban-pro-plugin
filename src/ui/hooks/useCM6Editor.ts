/**
 * useCM6Editor — controlled markdown editor mount point.
 *
 * This hook mounts an Obsidian-host CodeMirror 6 `EditorView` into a caller-
 * supplied DOM node. Per the architecture (Risks & mitigations → "Reuse
 * Obsidian's host CM6 via the editor APIs — avoids duplicate ~30KB"), we
 * never bundle CM6: `@codemirror/*` and `@lezer/*` are all marked external
 * in esbuild.config.mjs and resolve to the running Obsidian instance.
 *
 * Pool-of-one
 * ------------
 * Only one inline editor is open at a time across the entire board (the
 * existing UX broadcasts `kanban-pro:card-clicked` / `kanban-pro:dragstart`
 * to force commits). We exploit that by keeping a *module-level* "active"
 * EditorView reference and destroying it whenever a new one mounts. This
 * is a safety net against split-second mount/unmount races during drag —
 * not a substitute for the explicit commit broadcast.
 *
 * Fallback contingency
 * --------------------
 * If a peer's Obsidian build doesn't expose the CM6 packages at runtime,
 * the dynamic require throws and we fall back to a polished textarea.
 * The first failure path is logged once so plugin debug logs surface it.
 *
 * Signature (stable; do not change without coordination):
 *   useCM6Editor({ value, onChange, onCommit, autoFocus }):
 *     { mount, teardown, focus, getValue }
 *
 * Commit triggers handled inside the hook:
 *   - blur
 *   - Cmd/Ctrl + S
 *   - Cmd/Ctrl + Enter
 *   - `kanban-pro:dragstart` window event (parity with the textarea path)
 *
 * Cancel trigger:
 *   - Escape (the consumer wraps the host and reads this via onKeyDown too;
 *     we don't fire `onCommit` on Esc.)
 *
 * The hook never fires `onCommit` on plain Enter — that's the consumer's
 * decision (single-line cards vs. multi-line detail panel).
 */
import * as React from 'react';
import { licenseFSM } from '@/pro/license/state';

// --- CM6 imports ---------------------------------------------------------
// These are marked `external` in esbuild.config.mjs; at runtime esbuild
// preserves the require() so Obsidian resolves the live host modules.
// We import the types eagerly (devDep) but do the require lazily so that
// in non-Obsidian contexts (vitest) we silently fall back.
import type { EditorView as EditorViewType } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

let cm6: {
  EditorView: typeof EditorViewType;
  EditorState: typeof import('@codemirror/state').EditorState;
  keymap: typeof import('@codemirror/view').keymap;
  history: typeof import('@codemirror/commands').history;
  defaultKeymap: typeof import('@codemirror/commands').defaultKeymap;
  historyKeymap: typeof import('@codemirror/commands').historyKeymap;
} | null = null;
let cm6Available: boolean | null = null;

/**
 * D6 — Detect whether we're running inside Obsidian's Electron host.
 *
 * Per the architecture spec ("CodeMirror 6 — Not bundled. Reuse Obsidian's
 * host CM6 via the editor APIs"), the only valid runtime that ships CM6 to
 * this plugin is the Obsidian host. Loading CM6 from `node_modules` during
 * tests pulls in TWO copies of `@codemirror/state` because
 * `@codemirror/commands` ships a nested `node_modules/@codemirror/state`
 * whose copy is a different module object than the top-level one — and
 * CM6's cross-package `instanceof` checks then fail with:
 *   "multiple instances of @codemirror/state are loaded"
 *
 * That warning was the QA "CM6 mount failed, falling back to textarea"
 * report. Rather than try to dedupe the resolution graph (vitest's
 * `dedupe` works for ESM imports but our `require()` calls bypass it), we
 * skip the CM6 load entirely when we're not in Obsidian. The textarea
 * fallback is the same code path users on a peer build that doesn't expose
 * CM6 hit at runtime — exercising it from tests is the right thing.
 *
 * Detection: Obsidian's host injects `app://obsidian.md/` as the document
 * baseURI and exposes a global `process.type === 'renderer'` (Electron).
 * Vitest/jsdom satisfy neither. A `globalThis.__VITEST__` check is the
 * belt-and-suspenders signal for the test runner specifically.
 */
function isObsidianHost(): boolean {
  // Vitest sets globals on `globalThis`; the harness also sets
  // `process.env.VITEST`. Either is conclusive.
  if (typeof process !== 'undefined' && process?.env?.VITEST) return false;
  if ((globalThis as { __vitest_worker__?: unknown }).__vitest_worker__) return false;
  // Outside of Vitest we still want to refuse to load when there's no
  // Electron renderer process — that's the canonical Obsidian signal.
  // The check is permissive: any host that supplies `process.type ===
  // 'renderer'` (Electron) is treated as Obsidian-shaped. Plain Node and
  // browser runtimes lack this.
  const proc = (typeof process !== 'undefined' ? process : null) as
    | (NodeJS.Process & { type?: string })
    | null;
  if (proc?.type === 'renderer') return true;
  return false;
}

function loadCM6(): typeof cm6 {
  if (cm6Available === false) return null;
  if (cm6) return cm6;
  // D6 — bail before touching `require` in non-Obsidian runtimes. This
  // keeps the textarea fallback the only path exercised by tests, and
  // matches the architecture's "CM6 is host-provided" guarantee.
  if (!isObsidianHost()) {
    cm6Available = false;
    return null;
  }
  try {
    const view = require('@codemirror/view') as typeof import('@codemirror/view');
    const state = require('@codemirror/state') as typeof import('@codemirror/state');
    const commands = require('@codemirror/commands') as typeof import('@codemirror/commands');
    cm6 = {
      EditorView: view.EditorView,
      EditorState: state.EditorState,
      keymap: view.keymap,
      history: commands.history,
      defaultKeymap: commands.defaultKeymap,
      historyKeymap: commands.historyKeymap,
    };
    cm6Available = true;
    return cm6;
  } catch (err) {
    if (cm6Available === null) {
      // Log once; don't spam on every mount.
      console.warn('[kanban-pro] CodeMirror 6 not available, using textarea fallback', err);
    }
    cm6Available = false;
    return null;
  }
}

/** Module-level pool-of-one so racing mounts (e.g. fast drag) can't pile up. */
let active: EditorViewType | null = null;

export interface UseCM6EditorOptions {
  value: string;
  onChange?: (next: string) => void;
  onCommit?: (next: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

export interface CM6EditorHandle {
  mount: (el: HTMLElement) => void;
  teardown: () => void;
  /** Programmatically focus the underlying input. */
  focus: () => void;
  /** Read the current value without committing. */
  getValue: () => string;
}

export function useCM6Editor(opts: UseCM6EditorOptions): CM6EditorHandle {
  const { value, onChange, onCommit, autoFocus, placeholder } = opts;

  const elRef = React.useRef<HTMLElement | null>(null);
  // CM6 path
  const viewRef = React.useRef<EditorViewType | null>(null);
  // Fallback path
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether THIS hook instance has acquired the licenseFSM busy
  // hold. Re-mounts replace the editor; we release the prior hold before
  // acquiring a new one. Auto-cleanup useEffect releases on unmount.
  const busyHeldRef = React.useRef(false);

  const valueRef = React.useRef(value);

  // Keep the latest callbacks/value/opts in refs so listeners don't go stale
  // and the returned handle stays referentially stable across re-renders.
  const onChangeRef = React.useRef(onChange);
  const onCommitRef = React.useRef(onCommit);
  const autoFocusRef = React.useRef(autoFocus);
  const placeholderRef = React.useRef(placeholder);
  React.useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  React.useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  React.useEffect(() => { autoFocusRef.current = autoFocus; }, [autoFocus]);
  React.useEffect(() => { placeholderRef.current = placeholder; }, [placeholder]);

  // Sync external value updates into the active editor without disturbing
  // the user's caret if the value matches.
  React.useEffect(() => {
    valueRef.current = value;
    const v = viewRef.current;
    if (v) {
      const current = v.state.doc.toString();
      if (current !== value) {
        v.dispatch({
          changes: { from: 0, to: current.length, insert: value },
        });
      }
      return;
    }
    if (textareaRef.current && textareaRef.current.value !== value) {
      textareaRef.current.value = value;
    }
  }, [value]);

  // Cross-card commit signal — fire commit when any other card starts a drag.
  React.useEffect(() => {
    const onDragStart = () => {
      onCommitRef.current?.(valueRef.current);
    };
    window.addEventListener('kanban-pro:dragstart', onDragStart);
    return () => window.removeEventListener('kanban-pro:dragstart', onDragStart);
  }, []);

  const handle = React.useMemo<CM6EditorHandle>(() => {
    const mountFallback = (el: HTMLElement) => {
      const ta = document.createElement('textarea');
      // M1 — the fallback shows when Obsidian's host CM6 fails to resolve at
      // runtime (rare; happens in vitest and on some peer builds). We style
      // it to match the card body via the `.kp-inline-fallback` class
      // defined in card.css, so users never see a "monospaced dev preview".
      ta.className = 'kp-inline-fallback';
      ta.value = valueRef.current;
      if (placeholderRef.current) ta.placeholder = placeholderRef.current;
      ta.spellcheck = true;
      ta.rows = 3;

      ta.addEventListener('input', () => {
        valueRef.current = ta.value;
        onChangeRef.current?.(ta.value);
      });
      ta.addEventListener('blur', () => {
        onCommitRef.current?.(valueRef.current);
      });
      ta.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          onCommitRef.current?.(valueRef.current);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          onCommitRef.current?.(valueRef.current);
        }
      });

      el.appendChild(ta);
      textareaRef.current = ta;

      if (autoFocusRef.current) {
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        });
      }
    };

    const mountCM6 = (el: HTMLElement, mod: NonNullable<typeof cm6>) => {
      const { EditorView, EditorState, keymap, history, defaultKeymap, historyKeymap } = mod;

      // Tear down the pool-of-one survivor if any.
      if (active && active !== viewRef.current) {
        try { active.destroy(); } catch { /* noop */ }
        active = null;
      }

      const commitFromView = () => {
        const v = viewRef.current;
        if (!v) return;
        onCommitRef.current?.(v.state.doc.toString());
      };

      // Shortcut keymap entries — Cmd-S, Cmd-Enter both commit.
      // Returning `true` tells CM6 the keypress was handled.
      const commitKeymap = keymap.of([
        {
          key: 'Mod-s',
          run: () => { commitFromView(); return true; },
          preventDefault: true,
        },
        {
          key: 'Mod-Enter',
          run: () => { commitFromView(); return true; },
          preventDefault: true,
        },
      ]);

      // Domain plugin: report keystroke-level updates and commit-on-blur.
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          valueRef.current = next;
          onChangeRef.current?.(next);
        }
      });

      const blurHandler = EditorView.domEventHandlers({
        blur: () => {
          onCommitRef.current?.(viewRef.current?.state.doc.toString() ?? valueRef.current);
          return false;
        },
      });

      const extensions: Extension[] = [
        history(),
        commitKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        updateListener,
        blurHandler,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          // Aria + spellcheck — light touch.
          spellcheck: 'true',
        }),
      ];

      const state = EditorState.create({
        doc: valueRef.current,
        extensions,
      });

      const view = new EditorView({ state, parent: el });
      viewRef.current = view;
      active = view;

      if (autoFocusRef.current) {
        requestAnimationFrame(() => {
          try {
            view.focus();
            const len = view.state.doc.length;
            view.dispatch({ selection: { anchor: len, head: len } });
          } catch { /* noop */ }
        });
      }
    };

    return {
      mount: (el: HTMLElement) => {
        // Tear down any prior mount on this hook instance.
        if (viewRef.current) {
          try { viewRef.current.destroy(); } catch { /* noop */ }
          if (active === viewRef.current) active = null;
          viewRef.current = null;
        }
        if (textareaRef.current) {
          textareaRef.current.remove();
          textareaRef.current = null;
        }
        elRef.current = el;
        // Hold license FSM busy while an editor is open — any queued
        // license transition (revalidate result, grace boundary) waits
        // until the editor closes. Idempotent re-mounts don't double up.
        if (!busyHeldRef.current) {
          licenseFSM.setBusy(true);
          busyHeldRef.current = true;
        }

        const mod = loadCM6();
        if (mod) {
          // CM6 instance creation can throw outside Obsidian (e.g. vitest
          // resolves @codemirror/state via vitest's loader, producing a
          // duplicate-instance error). Fall back transparently if it does.
          try {
            mountCM6(el, mod);
            return;
          } catch (err) {
            console.warn('[kanban-pro] CM6 mount failed, falling back to textarea', err);
            cm6Available = false;
            cm6 = null;
          }
        }
        mountFallback(el);
      },
      teardown: () => {
        if (viewRef.current) {
          try { viewRef.current.destroy(); } catch { /* noop */ }
          if (active === viewRef.current) active = null;
          viewRef.current = null;
        }
        if (textareaRef.current) {
          textareaRef.current.remove();
          textareaRef.current = null;
        }
        elRef.current = null;
        if (busyHeldRef.current) {
          licenseFSM.setBusy(false);
          busyHeldRef.current = false;
        }
      },
      focus: () => {
        if (viewRef.current) {
          try { viewRef.current.focus(); } catch { /* noop */ }
          return;
        }
        textareaRef.current?.focus();
      },
      getValue: () => {
        if (viewRef.current) return viewRef.current.state.doc.toString();
        if (textareaRef.current) return textareaRef.current.value;
        return valueRef.current;
      },
    };
  }, []);

  // Auto-teardown when the consumer unmounts.
  React.useEffect(() => {
    return () => {
      if (viewRef.current) {
        try { viewRef.current.destroy(); } catch { /* noop */ }
        if (active === viewRef.current) active = null;
        viewRef.current = null;
      }
      if (textareaRef.current) {
        textareaRef.current.remove();
        textareaRef.current = null;
      }
      if (busyHeldRef.current) {
        licenseFSM.setBusy(false);
        busyHeldRef.current = false;
      }
    };
  }, []);

  return handle;
}

/**
 * Plugin-level Settings tab.
 *
 * Renders four panes: General, Appearance, Pro, Integrations. Each pane
 * is a self-contained module so we can swap them or add tabs without
 * touching this file.
 *
 * Pane contract: each `render(root, host, register)` may stash teardown
 * callbacks via `register(dispose)`. The SettingsTab keeps the list and
 * runs every disposer on `hide()` (and before re-rendering a different
 * pane). This is the canonical Obsidian pattern for subscription cleanup
 * and replaces an earlier MutationObserver-on-parentNode hack that
 * threw before the modal had finished mounting — taking the whole
 * Settings dialog down with it.
 */
import { App, PluginSettingTab, type Plugin } from 'obsidian';
import { renderGeneralPane } from './panes/General';
import { renderAppearancePane } from './panes/Appearance';
import { renderProPane } from './panes/Pro';
import { renderIntegrationsPane } from './panes/Integrations';
import type { PersistedLicense } from '@/pro/license/state';
import { log } from '@/shared/log';

export interface KanbanPluginSettings {
  defaultView: 'board' | 'table' | 'list';
  laneWidth: number;
  archiveWithDate: boolean;
  compatibilityMode: boolean;
  /**
   * **Deprecated**. Was the raw `email|key` activation input, persisted
   * by the Pro pane before the license FSM grew a `PersistedLicense`
   * shape. Kept in the settings type so old `data.json` files round-trip
   * cleanly and so the `Activate Pro license` command can re-activate
   * from a stale field; new writes go to `persistedLicense` instead.
   * Once a `persistedLicense` is present, this field is ignored on boot.
   */
  licenseToken: string | null;
  /**
   * Signed offline-verifiable license payload — what the FSM actually
   * persists post-activation. Holds the Ed25519-signed token, its `exp`,
   * the last successful server-validation timestamp, and the grace-clock
   * start (used by the 30d offline-tolerance contract).
   *
   * Wired in `main.ts.onload`: `licenseFSM.attachPersistence({load, save})`
   * is given a load/save pair that round-trips this field; `await
   * licenseFSM.load()` then verifies the cached token offline and brings
   * the gate up before any UI mounts. That is the cold-start
   * auto-activation path: a cached license must reactivate Pro silently
   * on startup without the user re-entering their key.
   */
  persistedLicense: PersistedLicense | null;
  /**
   * Cursor for the incremental revocations feed. The 24h poll in
   * `main.ts` reads this, calls `licenseFSM.pollRevocations(cursor)`,
   * and writes the returned cursor back. Default 0 (full window on
   * first poll).
   */
  revocationsCursor: number;
  /**
   * Hidden override for the license server base URL. There is no UI
   * for this — it is set via the Obsidian dev console or by editing
   * `data.json`, to point at a local or self-hosted deployment during
   * testing. When unset the plugin uses the production default baked
   * into `@/pro/license/remote`.
   */
  licenseServerBaseUrl?: string;
  github: {
    accessToken: string | null;
  };
  calendar: {
    icsExportEnabled: boolean;
  };
  /**
   * First-run welcome modal gate. Flipped to true in
   * `OnboardingModal.onClose()` so any dismissal path (X, Esc, CTA click)
   * is the signal — auto-trigger fires at most once per install. The
   * `Kanban Pro: Show getting started` command bypasses this flag and
   * re-opens the modal on demand without resetting it.
   */
  hasSeenOnboarding: boolean;
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
  defaultView: 'board',
  laneWidth: 272,
  archiveWithDate: true,
  compatibilityMode: false,
  licenseToken: null,
  persistedLicense: null,
  revocationsCursor: 0,
  github: { accessToken: null },
  calendar: { icsExportEnabled: false },
  hasSeenOnboarding: false,
};

export interface SettingsHost {
  settings: KanbanPluginSettings;
  saveSettings: () => Promise<void>;
  plugin: Plugin;
}

/**
 * Pane-level disposer registration. Each pane is passed a `register`
 * function it uses to enqueue teardown callbacks (license subscriptions,
 * window event listeners, etc). The SettingsTab runs every queued
 * disposer when `hide()` fires or when the active pane changes.
 */
export type PaneDisposerRegister = (dispose: () => void) => void;

interface PaneDescriptor {
  label: string;
  render: (root: HTMLElement, register: PaneDisposerRegister) => void;
}

export type PaneId = 'general' | 'appearance' | 'pro' | 'integrations';
const PANE_IDS: readonly PaneId[] = [
  'general',
  'appearance',
  'pro',
  'integrations',
] as const;

export class KanbanSettingsTab extends PluginSettingTab {
  /** Disposers attached by the currently-rendered pane. */
  private paneDisposers: Array<() => void> = [];
  /**
   * Index of the pane that `display()` should activate. Defaults to 0
   * (General); `openTo(paneId)` flips it before Obsidian re-renders.
   * Lets the `Activate Pro license` command land on the Pro
   * pane directly instead of forcing the user through a second click.
   */
  private initialPaneIndex = 0;
  /** Set when display() is mounted so openTo() can switch live. */
  private switchActive: ((index: number) => void) | null = null;

  constructor(app: App, private host: SettingsHost) {
    super(app, host.plugin);
  }

  /**
   * Pre-select which pane the next `display()` opens to, OR (if the
   * settings dialog is already mounted) switch to that pane immediately.
   * Used by `main.ts#openProSettings`: the "Activate Pro license" command
   * must land on Pro, not General.
   */
  openTo(paneId: PaneId): void {
    const idx = PANE_IDS.indexOf(paneId);
    if (idx < 0) return;
    this.initialPaneIndex = idx;
    // If the tab is currently mounted, flip the pane live.
    this.switchActive?.(idx);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty?.();
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
    // A fresh `display()` is a fresh DOM; any disposers from a previous
    // open are now orphaned (and may have already been flushed on
    // `hide()`, but flush again defensively).
    this.flushPaneDisposers();

    const tabs: PaneDescriptor[] = [
      { label: 'General', render: (r, reg) => renderGeneralPane(r, this.host, reg) },
      { label: 'Appearance', render: (r, reg) => renderAppearancePane(r, this.host, reg) },
      { label: 'Pro', render: (r, reg) => renderProPane(r, this.host, reg) },
      { label: 'Integrations', render: (r, reg) => renderIntegrationsPane(r, this.host, reg) },
    ];

    // Simple tab strip — no heavy UI; Obsidian's settings panel is plain DOM.
    const strip = document.createElement('div');
    strip.className = 'kanban-pro-settings-tabs';
    const body = document.createElement('div');
    body.className = 'kanban-pro-settings-body';
    containerEl.appendChild(strip);
    containerEl.appendChild(body);

    let active = Math.max(0, Math.min(this.initialPaneIndex, tabs.length - 1));
    // Expose a live-switch hatch so openTo() can flip the pane after the
    // dialog is already on screen. Cleared in hide() so a stale reference
    // doesn't outlive the DOM.
    this.switchActive = (index: number) => {
      const clamped = Math.max(0, Math.min(index, tabs.length - 1));
      if (clamped === active) return;
      active = clamped;
      renderActive();
    };
    const renderActive = () => {
      // Tearing down the previous pane before we wipe its DOM so any
      // disposer reaching into the soon-to-be-detached subtree sees it
      // still attached. Order here matters for the same reason React's
      // cleanup runs before the next effect: subscriptions, event
      // listeners, anything time-bound.
      this.flushPaneDisposers();

      body.empty?.();
      while (body.firstChild) body.removeChild(body.firstChild);

      const tab = tabs[active];
      const register: PaneDisposerRegister = (dispose) => {
        this.paneDisposers.push(dispose);
      };
      // Every pane render is wrapped: a throw inside one pane MUST NOT
      // take down the tab strip or block Esc/X. If a pane fails we
      // surface an inline error block and keep the rest of the modal
      // functional.
      try {
        tab.render(body, register);
      } catch (err) {
        log.error(`settings pane "${tab.label}" failed to render`, err);
        // Drop any disposers the pane registered before throwing — they
        // may reference half-initialized state.
        this.flushPaneDisposers();
        // Clear partial DOM and render a small error block so the user
        // knows the pane is broken (not the whole app).
        body.empty?.();
        while (body.firstChild) body.removeChild(body.firstChild);
        const errBlock = document.createElement('div');
        errBlock.className = 'kanban-pro-settings-error';
        const errHeading = document.createElement('strong');
        errHeading.textContent = `Couldn't render the ${tab.label} pane.`;
        const errBody = document.createElement('div');
        errBody.textContent =
          err instanceof Error ? err.message : 'See the developer console for details.';
        errBlock.appendChild(errHeading);
        errBlock.appendChild(errBody);
        body.appendChild(errBlock);
      }
      // Update tab strip aria/state.
      Array.from(strip.children).forEach((node, i) => {
        (node as HTMLElement).classList.toggle('is-active', i === active);
      });
    };

    tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kanban-pro-settings-tab';
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        active = i;
        renderActive();
      });
      strip.appendChild(btn);
    });

    renderActive();
  }

  /**
   * Obsidian calls `hide()` when the user navigates to a different
   * settings tab or closes the dialog. This is our hook to release pane
   * subscriptions before the DOM is torn down — the same way React
   * effect cleanups run before unmount.
   */
  hide(): void {
    this.flushPaneDisposers();
    this.switchActive = null;
    // Reset to General for next manual open. openTo() callers re-set
    // initialPaneIndex right before re-opening.
    this.initialPaneIndex = 0;
    // PluginSettingTab.hide() is currently a no-op in the typed API; call
    // through guardedly so any future override on the base behaves.
    const base = (PluginSettingTab.prototype as unknown as { hide?: () => void }).hide;
    base?.call(this);
  }

  private flushPaneDisposers(): void {
    const disposers = this.paneDisposers;
    this.paneDisposers = [];
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        log.error('settings pane disposer threw', err);
      }
    }
  }
}

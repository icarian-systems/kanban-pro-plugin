/**
 * Plugin entry — wires the host to our view layer.
 *
 * Lifecycle contract:
 *
 *  - Every onload-registered resource MUST register teardown via
 *    `this.register*()` so Obsidian's review process accepts the plugin.
 *  - `onunload()` must unmount React roots, dispose stores, unsubscribe
 *    vault listeners, cancel pending save timers. Most of that happens
 *    inside each KanbanView's own teardown; this file's job is to detach
 *    leaves and clear top-level handlers.
 */
import { Plugin, type WorkspaceLeaf, TFile, Notice, MarkdownView } from 'obsidian';
import { KanbanView, KANBAN_VIEW_TYPE } from './view/KanbanView';
import {
  DashboardView,
  DASHBOARD_VIEW_TYPE,
  setDashboardViewDeps,
} from './view/DashboardView';
import { registerEmbedProcessor } from './view/EmbedProcessor';
import {
  KanbanSettingsTab,
  DEFAULT_SETTINGS,
  type KanbanPluginSettings,
} from './settings/SettingsTab';
import { parseBoard, serializeBoard } from '@/core/parser';
import { renderSettingsBlock } from '@/core/parser/settingsBlock';
import { licenseFSM } from '@/pro/license/state';
import {
  createTemplateStore,
  type TemplateStore,
} from '@/core/templates';
import {
  createSavedViewStore,
  type SavedViewStore,
} from '@/pro/savedViews/store';
import { createTrackingStore } from '@/pro/tracking/store';
import type { TrackingStore } from '@/ui/contracts';
import { exportICS } from '@/pro/integrations/calendar';
import {
  createVaultIndex,
  type VaultIndex,
} from '@/core/vaultIndex';
import {
  installTemplateModal,
  type TemplateModalEventDetail,
} from '@/ui/TemplatesModal';
import {
  CreateOrOpenBoardModal,
  ExistingBoardSuggestModal,
} from '@/ui/CreateOrOpenBoardModal';
import { OnboardingModal } from '@/ui/OnboardingModal';
import {
  renderStarterBoardMarkdown,
  STARTER_BOARD_BASENAME,
} from '@/ui/starterBoard';
import { listExistingBoards } from '@/ui/boardDiscovery';
import { log } from '@/shared/log';

export default class KanbanProPlugin extends Plugin {
  settings: KanbanPluginSettings = DEFAULT_SETTINGS;
  /** Lazily created on first command that needs them. main.ts owns them so
   *  the per-view stores can read from a single source. */
  templates: TemplateStore | null = null;
  /**
   * Saved Views (Pro v1.0). Plugin-owned so every KanbanView leaf
   * shares the same instance — the picker UI in `BoardRoot` consumes
   * it via the `SavedViewsProvider` context.
   *
   * Persisted under the dedicated `savedViews` sub-key in plugin data
   * so it round-trips alongside `settings` / `templates` without
   * stomping any of them. See `src/pro/savedViews/store.ts`.
   */
  savedViews: SavedViewStore | null = null;
  /**
   * Time tracking (Pro v1.0). Plugin-owned so every KanbanView leaf shares
   * one instance — timer entries are vault-global (keyed by cardId) and
   * persisted under the dedicated `tracking` sub-key in plugin data. A
   * per-leaf store would split state and clobber entries on save. The
   * board tree reads it via `TrackingProvider` (see KanbanView).
   */
  tracking: TrackingStore | null = null;
  vaultIndex: VaultIndex | null = null;
  private compatModeListener: ((ev: Event) => void) | null = null;
  private statusBarEl: HTMLElement | null = null;
  private licenseUnsubscribe: (() => void) | null = null;
  /**
   * The plugin's settings tab instance. Held so `openProSettings()` can
   * pre-select the Pro pane before Obsidian re-renders the dialog —
   * fixes the "Activate Pro license lands on General" bug.
   */
  private settingsTab: KanbanSettingsTab | null = null;
  /**
   * Re-entrancy guard for the onboarding modal. The auto-trigger and
   * the `Show getting started` command can both call
   * `openOnboardingModal()` — without this guard, double invocation
   * would stack two modals on top of each other.
   */
  private currentOnboardingModal: OnboardingModal | null = null;

  async onload(): Promise<void> {
    log.info(`loading ${this.manifest.name} ${this.manifest.version}`);

    await this.loadSettings();

    // Hidden override for the license server base URL — set via the
    // Obsidian dev console or by editing data.json. Must run BEFORE
    // anything that might touch the license FSM (activate/revalidate)
    // so the FSM's first network call lands on the right host.
    if (this.settings.licenseServerBaseUrl) {
      const { setLicenseServerBaseUrl } = await import('@/pro/license/remote');
      setLicenseServerBaseUrl(this.settings.licenseServerBaseUrl);
    }

    // License persistence wiring.
    //
    // The FSM is persistence-agnostic by design — it owns the wire format
    // (PersistedLicense), and the host plugin supplies the actual
    // load/save callbacks. Attaching here BEFORE `load()` means the
    // boot-time offline verify path will both (a) hydrate the gate from
    // disk, and (b) refresh the persisted record (e.g. exit-grace) via
    // the same `save()` channel without us having to special-case
    // anything. `load()` is awaited so the gate is settled before any
    // view mounts and reads `useProGate()` — otherwise a freshly-restored
    // KanbanView would flash "Free · unlicensed" for one tick on every
    // cold start.
    licenseFSM.attachPersistence({
      load: async () => this.settings.persistedLicense ?? null,
      save: async (p) => {
        this.settings.persistedLicense = p;
        await this.saveSettings();
      },
    });
    await licenseFSM.load();

    // Templates + saved views + vault index. Construction is cheap
    // (hydration is fire-and-forget); ownership lives on the plugin so
    // commands, the dashboard, and every leaf's BoardRoot share a single
    // instance.
    this.templates = createTemplateStore(this);
    this.savedViews = createSavedViewStore(this);
    this.tracking = createTrackingStore(this);
    this.vaultIndex = createVaultIndex(this);
    setDashboardViewDeps({ vaultIndex: this.vaultIndex });

    // Views — both registered up front so workspace restore doesn't crash
    // on a serialized DashboardView reference.
    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf));
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf));

    // File-extension binding. Boards are .md files with `kanban-plugin: board`
    // frontmatter — but we use `registerExtensions` only when the user
    // explicitly forces a board view; the default mechanism is the
    // command "Open as Kanban" and the layout-restoration hook below.
    // The post-processor handles embeds.
    registerEmbedProcessor(this);

    // Status bar — "Kanban Pro · Free" / "Kanban Pro · Pro".
    // Subscribes to the license FSM so the text
    // flips immediately when activation succeeds.
    this.statusBarEl = this.addStatusBarItem();
    this.refreshStatusBar();
    this.licenseUnsubscribe = licenseFSM.subscribe(() => this.refreshStatusBar());
    this.register(() => {
      this.licenseUnsubscribe?.();
      this.licenseUnsubscribe = null;
    });

    // Ribbon — opens a chooser modal. The
    // modal then either calls createNewBoard() or routes to an existing
    // kanban-formatted file via openBoardFile().
    this.addRibbonIcon('kanban-square', 'Kanban Pro', () => {
      new CreateOrOpenBoardModal(this.app, {
        onCreate: () => this.createNewBoard(),
        onOpen: (file) => this.openBoardFile(file),
      }).open();
    });

    // Commands.
    //
    // Naming convention: Obsidian's command palette already prefixes
    // each entry with the plugin's manifest `name` ("Kanban Pro: …") —
    // so the `name:` field MUST NOT repeat that prefix. (Pass-3 QA
    // surfaced `Kanban Pro: Kanban: Create new board` as a cosmetic
    // regression; fixed here.) Command `id:` values stay as-is so
    // existing keybinding configurations keep working.
    this.addCommand({
      id: 'create-board',
      name: 'Create new board',
      callback: () => {
        // Same modal the ribbon opens — keeps a single create/open entry
        // point.
        new CreateOrOpenBoardModal(this.app, {
          onCreate: () => this.createNewBoard(),
          onOpen: (file) => this.openBoardFile(file),
        }).open();
      },
    });

    this.addCommand({
      id: 'kanban-pro-cycle-view-mode',
      name: 'Cycle view mode (Board / Table / List)',
      // No default hotkey: per Obsidian's plugin guidelines we ship commands
      // unbound and let users assign their own chord in Hotkeys settings.
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        view?.cycleViewMode();
      },
    });

    this.addCommand({
      id: 'validate-board',
      name: 'Validate board',
      // "Validate board is silent". Two regressions in the
      // earlier shape: (a) a `checkCallback` gated on metadata-cache
      // frontmatter, which silently hid the command on freshly-opened
      // files where the cache hadn't parsed yet; (b) the callback didn't
      // try/catch around `parseBoard`/`serializeBoard`, so a synchronous
      // throw from the parser surfaced as an unhandled-rejection without
      // a Notice. Always-available callback PLUS a top-level try/catch
      // means the user always sees feedback that the command did
      // something — success, diff, or an error explanation.
      callback: () => {
        void this.validateActiveBoard().catch((err) => {
          log.error('validate command: unexpected throw', err);
          new Notice('Validate board: unexpected error — see console.');
        });
      },
    });

    this.addCommand({
      id: 'kanban-pro-canonicalize-board',
      name: 'Canonicalize this board',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        if (!view) return false;
        if (!checking) void this.canonicalizeActiveBoard();
        return true;
      },
    });

    // Calendar (.ics) export — Pro. Writes an .ics of every dated card next to
    // the board file. The Integrations pane surfaces the same action via a
    // button; both route here so the gating + write path stay in one place.
    this.addCommand({
      id: 'kanban-pro-export-ics',
      name: 'Export board to calendar (.ics)',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        if (!view) return false;
        if (!checking) void this.exportActiveBoardICS();
        return true;
      },
    });

    // Gesture-scoped undo. The undo stack is per-view. No default hotkey is
    // set (per Obsidian's plugin guidelines); the command stays disabled
    // unless a KanbanView is active AND has at least one snapshot, so any
    // chord a user assigns falls through to Obsidian's native undo elsewhere.
    this.addCommand({
      id: 'kanban-pro-undo',
      name: 'Undo last drag',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        if (!view || !view.canUndo()) return false;
        if (!checking) view.undo();
        return true;
      },
    });

    // Redo. Same gating discipline as undo and likewise shipped without a
    // default hotkey: the command only activates when a KanbanView is active
    // AND there's a redo entry, so a user-assigned chord falls through to
    // Obsidian's native redo when our stack is empty.
    this.addCommand({
      id: 'kanban-pro-redo',
      name: 'Redo',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        if (!view || !view.canRedo()) return false;
        if (!checking) view.redo();
        return true;
      },
    });

    this.addCommand({
      id: 'kanban-pro-license-activate',
      name: 'Activate Pro license',
      callback: async () => {
        // If we already have a stored token, attempt activation directly
        // — preserves the keyboard-only power-user path. Otherwise open
        // Settings → Pro and focus the input so the user can paste
        // immediately (the previous Notice-only behaviour left
        // users with no working path to activation when combined with
        // the broken settings tab).
        //
        // Preference order: a signed `persistedLicense.token` always wins
        // over the legacy raw `email|key` field. The legacy field is a
        // pre-FSM relic from 1.0.0 installs and should only be used as a
        // fall-back when no signed token has ever been persisted. Without
        // this guard, a user who activated successfully (signed token on
        // disk) but never deactivated would have the command re-exchange
        // the raw key on every invocation, defeating the FSM cache.
        if (this.settings.persistedLicense?.token) {
          // Already have a signed token — just open the Pro pane so the
          // user can see status / revalidate / deactivate. The FSM's
          // `load()` ran in onload(), so the gate is already up.
          this.openProSettings();
          return;
        }
        if (this.settings.licenseToken) {
          try {
            const gate = await licenseFSM.activate(this.settings.licenseToken);
            new Notice(`License: ${gate.tier} · ${gate.state}`);
          } catch (err) {
            log.error('license activate command failed', err);
            new Notice('License activation failed. See console.');
          }
          return;
        }
        this.openProSettings();
      },
    });

    this.addCommand({
      id: 'kanban-pro-insert-template',
      name: 'Insert from template',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        const store = view?.getStore();
        if (!store || !this.templates) return false;
        if (checking) return true;
        const detail: TemplateModalEventDetail = {
          app: this.app,
          store,
          templateStore: this.templates,
        };
        window.dispatchEvent(
          new CustomEvent('kanban-pro:open-template-modal', { detail }),
        );
        return true;
      },
    });

    this.addCommand({
      id: 'kanban-pro-open-dashboard',
      name: 'Open Dashboard',
      callback: async () => {
        await this.openDashboard();
      },
    });

    this.addCommand({
      id: 'kanban-pro-show-getting-started',
      name: 'Show getting started',
      callback: () => this.openOnboardingModal('command'),
    });

    this.addCommand({
      id: 'kanban-pro-rebuild-vault-index',
      name: 'Rebuild vault index',
      callback: async () => {
        if (!this.vaultIndex) {
          new Notice('Rebuild vault index: index unavailable.');
          return;
        }
        new Notice('Rebuilding vault index…');
        try {
          await this.vaultIndex.rebuild();
        } catch (err) {
          log.error('rebuild vault index failed', err);
          new Notice('Rebuild vault index: failed — see console.');
          return;
        }
        const count = this.vaultIndex.list().length;
        new Notice(
          `Indexed ${count} board${count === 1 ? '' : 's'}.`,
        );
      },
    });

    // Settings tab — four panes. Keep a reference so commands can ask
    // it to pre-select a specific pane (Activate-Pro must land
    // on Pro).
    this.settingsTab = new KanbanSettingsTab(this.app, {
      plugin: this,
      settings: this.settings,
      saveSettings: async () => {
        await this.saveSettings();
      },
    });
    this.addSettingTab(this.settingsTab);

    // Auto-open .md files with `kanban-plugin: board` frontmatter in our
    // view instead of the default Markdown view. The metadata cache may
    // not have parsed the frontmatter yet when `file-open` first fires for
    // a freshly-created file, so we also listen for the corresponding
    // `metadataCache changed` event and retry the routing decision there.
    //
    // `file-open` doesn't always fire when the user navigates
    // back to a previously-restored leaf (Obsidian's workspace state can
    // bind the leaf to `markdown` view type before our handler gets a
    // chance). `active-leaf-change` is the third safety net — every time
    // a leaf gains focus we re-evaluate its file. All three paths are
    // idempotent (`maybeRouteToKanbanView` no-ops when the leaf is
    // already our type).
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.maybeRouteToKanbanView(file);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        this.maybeRouteToKanbanView(file);
      }),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (!view) return;
        if (view.getViewType?.() === KANBAN_VIEW_TYPE) return;
        if (!(view instanceof MarkdownView)) return;
        this.maybeRouteToKanbanView(view.file);
      }),
    );

    // Re-apply the routing to already-open tabs on plugin reload.
    //
    // Without this, toggling the plugin off/on leaves every previously-
    // routed `.md` board tab stranded as a plain Markdown view. The
    // `file-open` / `metadataCache.changed` / `active-leaf-change` hooks
    // above only fire for *new* opens, leaf focus changes, or cache
    // updates — none of which trigger on the post-reload restore path
    // (Obsidian rebuilds the workspace tree before our `onload` runs).
    //
    // We defer until `onLayoutReady` so the workspace tree exists and
    // every leaf has been rehydrated. From there, iterate all open leaves
    // and run them back through `maybeRouteToKanbanView` — that helper is
    // idempotent (no-ops for non-board files and for leaves already in
    // our view type), so it's safe to fire over the entire workspace.
    const routeOpenLeaves = (): void => {
      this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
        const view = leaf.view;
        if (!view) return;
        const vt = view.getViewType?.();
        if (vt === KANBAN_VIEW_TYPE) return;
        if (!(view instanceof MarkdownView)) return;
        // The file might be null for empty leaves; the helper handles
        // that by no-op'ing on non-TFile inputs.
        this.maybeRouteToKanbanView(view.file);
      });
    };
    const workspaceWithReady = this.app.workspace as unknown as {
      onLayoutReady?: (cb: () => void) => void;
    };
    if (typeof workspaceWithReady.onLayoutReady === 'function') {
      workspaceWithReady.onLayoutReady(routeOpenLeaves);
    } else {
      // Test/legacy hosts without onLayoutReady — defer with a microtask
      // so the rest of onload finishes wiring before we start flipping
      // leaves.
      queueMicrotask(routeOpenLeaves);
    }

    // First-run onboarding. Gated on `hasSeenOnboarding` so the modal
    // auto-fires at most once per install — the `Show getting started`
    // command ignores the flag for users who want to re-read it.
    //
    // Two variants:
    //   - "migrator" when the vault already has `kanban-plugin: board`
    //     files (incumbent users coming from mgmeyers/obsidian-kanban —
    //     reassure them their files are unchanged, don't pitch a starter)
    //   - "fresh" otherwise (offer the starter board as the primary CTA)
    //
    // Detection timing matters: at `onLayoutReady`, the metadata cache
    // is rebuilt for *open* leaves but may not have parsed every file
    // in a large vault yet. We hook `metadataCache.on('resolved')` so
    // detection runs against a settled cache — this is the same
    // ordering rationale as `maybeRouteToKanbanView`'s dual-listen on
    // `file-open` + `metadataCache changed`. A microtask fallback
    // covers headless/test hosts where 'resolved' never fires.
    if (!this.settings.hasSeenOnboarding) {
      // CRITICAL: `metadataCache.on('resolved', ...)` is NOT a one-time
      // event — it fires every time the cache finishes re-indexing, which
      // happens after EVERY board write (create board, add card, drag,
      // toggle a checkbox, rename a lane…). The old `openOnce` guarded only
      // on `currentOnboardingModal`, so once the user dismissed the modal
      // the next board edit re-resolved the cache and re-opened it — the
      // "Welcome modal re-appears on every edit" bug. Fix: (a) bail hard if
      // the persisted `hasSeenOnboarding` flag is set, and (b) DETACH this
      // listener the first time it fires so later re-resolves can't wake it.
      let resolvedRef: unknown = null;
      const detachResolved = (): void => {
        if (!resolvedRef) return;
        const mc = this.app.metadataCache as unknown as {
          offref?: (ref: unknown) => void;
        };
        try {
          mc.offref?.(resolvedRef);
        } catch {
          /* best-effort detach; the hasSeenOnboarding guard is the backstop */
        }
        resolvedRef = null;
      };
      const openOnce = (): void => {
        if (this.settings.hasSeenOnboarding || this.currentOnboardingModal) {
          // Already shown this session, or persisted as seen — never
          // auto-open again, and make sure the one-shot listener is gone.
          detachResolved();
          return;
        }
        // First (and only) auto-open. Detach BEFORE opening so a write the
        // modal itself may trigger can't re-enter this path.
        detachResolved();
        this.openOnboardingModal('auto');
      };
      // `metadataCache.on('resolved', ...)` is not in the published
      // `obsidian.d.ts` typings but is dispatched at runtime once the
      // cache has parsed every file. Cast to access it; the helper
      // returns an EventRef shape we hand back to `registerEvent` for
      // teardown safety.
      const mcEvents = this.app.metadataCache as unknown as {
        on?: (ev: string, cb: () => void) => unknown;
      };
      if (typeof mcEvents.on === 'function') {
        try {
          resolvedRef = mcEvents.on('resolved', openOnce);
          this.registerEvent(resolvedRef as Parameters<Plugin['registerEvent']>[0]);
        } catch {
          // Cache may have already resolved; fall through to the microtask.
        }
      }
      // Always-fire fallback. Idempotent via the guards in `openOnce`.
      queueMicrotask(openOnce);
    }

    // Compatibility mode → CSS class on every Kanban leaf container. We
    // listen to the General-pane's custom event so the toggle takes effect
    // without a leaf reload.
    this.applyCompatClassToOpenLeaves(this.settings.compatibilityMode);
    this.compatModeListener = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ enabled: boolean }>).detail;
      this.applyCompatClassToOpenLeaves(detail?.enabled === true);
    };
    window.addEventListener(
      'kanban-pro:compat-mode-changed',
      this.compatModeListener,
    );
    this.register(() => {
      if (this.compatModeListener) {
        window.removeEventListener(
          'kanban-pro:compat-mode-changed',
          this.compatModeListener,
        );
        this.compatModeListener = null;
      }
    });

    // Install the template-picker modal listener. Lives on window for the
    // plugin's lifetime; cleanup runs on plugin unload.
    this.register(installTemplateModal(this.app));

    // `kanban-pro:open-pro-settings` — dispatched by PaywallCard,
    // BoardRoot's Dashboard subnav (Free-tier path), TemplatesModal,
    // and CardTrackingChip. All consumers want the same outcome: open the
    // plugin's Settings → Pro pane. Same path the Activate command uses.
    const onOpenProSettings = (): void => {
      this.openProSettings();
    };
    window.addEventListener('kanban-pro:open-pro-settings', onOpenProSettings);
    this.register(() =>
      window.removeEventListener('kanban-pro:open-pro-settings', onOpenProSettings),
    );

    // `kanban-pro:open-dashboard` — dispatched by the board subnav's
    // Dashboard tab. The subnav can't reliably reach our command via
    // `app.commands.executeCommandById` (the private API returns `undefined`
    // for an unknown id, and the id must be prefixed with the manifest id,
    // not the view type) — so the toolbar button silently did nothing. We
    // own the open here instead; `openDashboard()` renders the Free-tier
    // paywall itself, so Free and Pro both land in the right place.
    const onOpenDashboard = (): void => {
      void this.openDashboard();
    };
    window.addEventListener('kanban-pro:open-dashboard', onOpenDashboard);
    this.register(() =>
      window.removeEventListener('kanban-pro:open-dashboard', onOpenDashboard),
    );

    // Audited — no plugin-side cause for duplicate Welcome tabs;
    // verify in user's vault `workspace.json`. We never call
    // `workspace.openLinkText` or `workspace.getLeaf().openFile` at boot,
    // and `registerView` / `registerEvent` for each type fire exactly
    // once per onload.

    // Kick off a one-off vault index rebuild after onload returns so we
    // don't block plugin boot. The dashboard's first open will see live
    // data either way.
    setTimeout(() => {
      void this.vaultIndex?.rebuild().catch((err) => {
        log.warn('initial vault-index rebuild failed', err);
      });
    }, 0);

    // Weekly background license revalidate (LIC-7). The FSM's
    // idle-boundary rule (pro/license/state.ts) holds queued transitions
    // until DnD / inline editor / save flight all release — so a
    // revalidate result landing mid-drag won't commit a Pro→Free flip
    // until the user lets go. First fire is one week from now; we don't
    // revalidate on boot because the boot-time licenseFSM.load() path
    // already verifies the cached token offline.
    const REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    const revalidateIntervalId = window.setInterval(() => {
      void licenseFSM.revalidate().catch((err) => {
        log.warn('weekly license revalidate failed', err);
      });
    }, REVALIDATE_INTERVAL_MS);
    this.register(() => window.clearInterval(revalidateIntervalId));

    // Daily revocations poll (LIC-8). The cursor is persisted via plugin
    // settings so we only ever fetch the delta since the last successful
    // call. The FSM stays persistence-agnostic — it returns the new
    // cursor here and we round-trip it through saveSettings. If a poll
    // demotes us (server reports our `sub` as revoked) the FSM commits
    // the transition itself, gated by the same idle-boundary rule as
    // every other state change.
    const REVOCATIONS_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const revocationsIntervalId = window.setInterval(() => {
      void (async () => {
        try {
          const cursor = this.settings.revocationsCursor ?? 0;
          const { cursor: nextCursor } = await licenseFSM.pollRevocations(cursor);
          if (nextCursor !== cursor) {
            this.settings.revocationsCursor = nextCursor;
            await this.saveSettings();
          }
        } catch (err) {
          log.warn('daily revocations poll failed', err);
        }
      })();
    }, REVOCATIONS_INTERVAL_MS);
    // `registerInterval` on Plugin returns the same id and arranges
    // auto-clearInterval on unload — pair it with the explicit
    // `this.register(clear)` we use elsewhere for symmetry.
    this.registerInterval(revocationsIntervalId);
  }

  async onunload(): Promise<void> {
    log.info('unloading kanban-pro');
    // Detach all leaves of our view types — Obsidian then disposes them,
    // which routes through KanbanView.onClose → teardownSession (where
    // the per-leaf cleanup checklist runs: react root, save queue, etc).
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const vt = leaf.view?.getViewType?.();
      if (vt === KANBAN_VIEW_TYPE || vt === DASHBOARD_VIEW_TYPE) {
        void (leaf as unknown as { detach: () => void }).detach?.();
      }
    });
    // Everything else (commands, settingsTab, ribbon, registerView,
    // registerMarkdownPostProcessor, registerEvent) is auto-torn-down by
    // Obsidian because we used the register*() helpers throughout.
  }

  // ──────────────────────────────────────────────────────────────────
  // Settings persistence
  // ──────────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    // plugin.loadData() returns a single record. main.ts owns the
    // `settings`-keyed fields; the template store reads its own
    // `templates` key from the same record. Both round-trip via
    // saveData(...) which receives the full record on every save —
    // each owner is responsible for not stomping the others.
    const data = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...((data ?? {}) as Partial<KanbanPluginSettings>) };
  }

  async saveSettings(): Promise<void> {
    // Read-modify-write so we don't wipe `templates` (or future siblings).
    const existing = (await this.loadData()) as Record<string, unknown> | null;
    const next = { ...(existing ?? {}), ...this.settings };
    await this.saveData(next);
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * If the given file looks like a Kanban board (`.md` + frontmatter key
   * `kanban-plugin: board`), find the leaf currently displaying it as
   * a Markdown view and flip that leaf's view type to KanbanView.
   *
   * Called from both `workspace.on('file-open')` and
   * `metadataCache.on('changed')` — the first fires before the cache has
   * resolved a freshly-created file's frontmatter, the second covers that
   * case once parsing finishes. Both call sites are idempotent: we no-op
   * if the file is already in our view type.
   */
  private maybeRouteToKanbanView(file: unknown): void {
    if (!(file instanceof TFile)) return;
    if (file.extension !== 'md') return;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm || fm['kanban-plugin'] !== 'board') return;

    // Find every leaf whose Markdown view is currently showing this file.
    // We rebind each one; in practice there's at most one.
    const leavesToFlip: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (!view) return;
      const vt = view.getViewType?.();
      if (vt === KANBAN_VIEW_TYPE) return; // already ours
      if (!(view instanceof MarkdownView)) return;
      if (view.file?.path !== file.path) return;
      leavesToFlip.push(leaf);
    });

    for (const leaf of leavesToFlip) {
      void leaf.setViewState({
        type: KANBAN_VIEW_TYPE,
        state: { file: file.path },
        active: true,
      });
    }
  }

  /**
   * Create a fresh Kanban board file and open it. Filename, lanes, and
   * settings-block format are chosen so the on-disk bytes round-trip
   * through the validator without diff.
   *
   * Lanes: `## Backlog`, `## In Progress`, `## Done`, all empty. The
   * settings block uses `renderSettingsBlock` which emits the canonical
   * fenced JSON form expected by the parser (see `sentinels.ts` and
   * `settingsBlock.ts`).
   */
  private async createNewBoard(): Promise<void> {
    const path = this.uniqueBoardPath('Untitled Board');
    const content = [
      '---',
      'kanban-plugin: board',
      '---',
      '',
      '## Backlog',
      '',
      '## In Progress',
      '',
      '## Done',
      '',
      renderSettingsBlock({ 'kanban-plugin': 'board' }),
    ].join('\n');

    const file = (await (this.app.vault as unknown as {
      create: (p: string, c: string) => Promise<TFile>;
    }).create(path, content)) as TFile;
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  /**
   * Create the "Welcome to Kanban Pro" starter board and open it.
   *
   * Mirrors `createNewBoard()` but with seed cards designed to teach
   * the drag-and-drop gesture by doing. The markdown is built via the
   * pure `renderStarterBoardMarkdown()` helper so the round-trip
   * contract is unit-testable in isolation from the plugin.
   */
  private async createStarterBoard(): Promise<void> {
    const path = this.uniqueBoardPath(STARTER_BOARD_BASENAME);
    const content = renderStarterBoardMarkdown();
    const file = (await (this.app.vault as unknown as {
      create: (p: string, c: string) => Promise<TFile>;
    }).create(path, content)) as TFile;
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  /**
   * Open the first-run welcome modal.
   *
   * `trigger` controls whether dismissal flips `hasSeenOnboarding`:
   *   - `'auto'` — first plugin load; dismissal persists the flag so
   *     the modal does not auto-reappear next session.
   *   - `'command'` — user explicitly ran `Show getting started`;
   *     dismissal is a no-op on the flag.
   *
   * Detects existing kanban-format files to pick the modal variant.
   * Re-entrancy guarded via `currentOnboardingModal`.
   */
  private openOnboardingModal(trigger: 'auto' | 'command'): void {
    if (this.currentOnboardingModal) return;
    const boards = listExistingBoards(this.app);
    const variant = boards.length > 0 ? 'migrator' : 'fresh';
    const modal: OnboardingModal = new OnboardingModal(
      this.app,
      variant,
      boards.length,
      {
        onCreateStarter: () => this.createStarterBoard(),
        onCreateBlank: () => this.createNewBoard(),
        onOpenExisting: () => {
          new ExistingBoardSuggestModal(this.app, (f) =>
            this.openBoardFile(f),
          ).open();
        },
        onOpenProSettings: () => {
          window.dispatchEvent(
            new CustomEvent('kanban-pro:open-pro-settings', {
              detail: { feature: 'Onboarding' },
            }),
          );
        },
        onDismiss: async () => {
          this.currentOnboardingModal = null;
          // The flag is normally already set eagerly below; this is the
          // backstop for the `auto` path in case eager persistence was
          // skipped (e.g. a host where saveSettings rejected on open).
          if (trigger === 'auto' && !this.settings.hasSeenOnboarding) {
            this.settings.hasSeenOnboarding = true;
            await this.saveSettings();
          }
        },
      },
    );
    this.currentOnboardingModal = modal;
    // Persist "seen" eagerly for the auto path so a board write mid-
    // onboarding (or a crash before dismissal) can never make the modal
    // auto-reappear next session. The `command` path leaves the flag alone
    // so power users can re-read getting-started without consuming it.
    if (trigger === 'auto' && !this.settings.hasSeenOnboarding) {
      this.settings.hasSeenOnboarding = true;
      void this.saveSettings();
    }
    modal.open();
  }

  private refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    const gate = licenseFSM.getGate();
    const label = gate.tier === 'pro' ? 'Pro' : 'Free';
    this.statusBarEl.setText(`Kanban Pro · ${label}`);
  }

  /**
   * Open an existing kanban-formatted file in a new leaf. The file-open
   * hook (`maybeRouteToKanbanView`) then flips the leaf's view type to
   * KanbanView. Used by the ribbon's "Open existing…" branch.
   */
  private async openBoardFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  /**
   * Resolve a vault-root path that doesn't collide with an existing file.
   * Tries `${base}.md`, `${base} 2.md`, `${base} 3.md`, … in order.
   */
  private uniqueBoardPath(base: string): string {
    const first = `${base}.md`;
    if (!this.app.vault.getAbstractFileByPath(first)) return first;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base} ${i}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    // Vanishingly unlikely fall-through; let Obsidian surface the collision.
    return first;
  }

  /**
   * Round-trip the active board through the parser and report any byte
   * divergence vs the on-disk source. This is the in-Obsidian sibling of
   * `scripts/validate.mjs` and is the v1 acceptance test for "open ⇒
   * save unchanged ⇒ no diff" — the same invariant the migration cohort
   * will rely on when they move off the incumbent plugin.
   *
   * Reads bytes from disk (not from the view's in-memory buffer) so we
   * exercise the same code path a fresh open would. Parse errors surface
   * as a red Notice; a non-zero byte diff also surfaces as a red Notice
   * with the count of differing bytes; a clean round-trip is green.
   */
  private async validateActiveBoard(): Promise<void> {
    // Prefer the active KanbanView's file when one is open — the metadata
    // cache can lag on freshly-created boards, so trusting the view's own
    // record sidesteps the "no kanban-plugin frontmatter" misfire when
    // the file IS a board but the cache hasn't caught up yet.
    const activeView = this.app.workspace.getActiveViewOfType(KanbanView);
    const activeFile = activeView?.file ?? this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('Validate board: open a Kanban board first.');
      return;
    }
    if (activeFile.extension !== 'md') {
      new Notice('Validate board: active file is not Markdown.');
      return;
    }
    // Frontmatter check stays advisory — if we DO have a KanbanView open
    // for this file, we trust the view's classification regardless of
    // whether the metadata cache has caught up.
    if (!activeView) {
      const cache = this.app.metadataCache.getFileCache(activeFile);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      if (!fm || fm['kanban-plugin'] !== 'board') {
        new Notice(
          'Validate board: active file has no `kanban-plugin: board` frontmatter.',
        );
        return;
      }
    }
    let source: string;
    try {
      source = await this.app.vault.read(activeFile);
    } catch (err) {
      log.error('validate: vault.read failed', err);
      new Notice('Validate board: failed to read the active file.');
      return;
    }
    // Wrap the parse + serialize in try/catch — a synchronous throw from
    // the parser must not slip past the command without a Notice (root
    // cause: the previous shape let the unhandled rejection surface as
    // dev-tools-only noise the user never saw).
    let parsed: ReturnType<typeof parseBoard>;
    try {
      parsed = parseBoard(source);
    } catch (err) {
      log.error('validate: parseBoard threw', err);
      new Notice(`Validate board: parser threw — ${String(err)}`);
      return;
    }
    if (!parsed.board) {
      const first = parsed.errors[0]?.message ?? 'unknown parse error';
      new Notice(`Validate board: parse failed — ${first}`);
      return;
    }
    if (parsed.errors.some((e) => e.severity === 'error')) {
      const first = parsed.errors.find((e) => e.severity === 'error');
      new Notice(`Validate board: parse error — ${first?.message ?? 'unknown'}`);
      return;
    }
    let out: string;
    try {
      out = serializeBoard(parsed.board, source);
    } catch (err) {
      log.error('validate: serializeBoard threw', err);
      new Notice(`Validate board: serializer threw — ${String(err)}`);
      return;
    }
    if (out === source) {
      new Notice(
        `Validated board · zero byte-diff (${source.length} bytes).`,
      );
      return;
    }
    const diffBytes = countByteDiff(source, out);
    new Notice(
      `Validate board: ${diffBytes} byte(s) differ on round-trip (in ${source.length} → out ${out.length}). See console.`,
    );
    log.warn('validate: byte-diff', {
      diffBytes,
      inLen: source.length,
      outLen: out.length,
      // First-line preview makes the dev-console output greppable across a
      // session of running validate on multiple files.
      previewIn: source.slice(0, 120),
      previewOut: out.slice(0, 120),
    });
  }

  /**
   * Canonicalize the active board.
   *
   * Contract: canonicalize is a *normalization* pass
   * over whitespace and the settings block only. It MUST NOT drop cards,
   * lanes, or any field/meta value (assignee, tags, dates, recurrence,
   * etc.). Round-trip the parsed model through the canonical writer and
   * verify the result re-parses to the same lane/card/field shape; if it
   * doesn't, abort without writing.
   *
   * We pre-count cards before and after the round-trip and surface the
   * outcome via Notice so the operation is no longer silent — the
   * "no toast, no undo entry" behavior was the second half of
   * the data-loss bug. A canonicalize that survives the equality check
   * is also pushed onto the undo stack as a single gesture so Cmd+Z
   * reverts it.
   */
  private async canonicalizeActiveBoard(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(KanbanView);
    if (!view) {
      new Notice('Canonicalize: open a Kanban board first.');
      return;
    }
    const source = view.getViewData();
    const parsed = parseBoard(source);
    if (!parsed.board) {
      new Notice('Canonicalize aborted — parse failed.');
      return;
    }

    // Count cards (and snapshot lane/card field shape) so we can verify
    // the round-trip preserved them. If anything dropped, abort without
    // writing — the user keeps their data.
    const beforeShape = boardShape(parsed.board);
    const cardCount = beforeShape.totalCards;

    const canonicalBoard = {
      ...parsed.board,
      settings: {
        ...parsed.board.settings,
        'kanban-canonical': true,
      },
    };
    // Pass an empty prev source to bypass the byte-identity fast-path; the
    // canonical-mode flag also triggers the full rewrite, but being explicit
    // here keeps the contract obvious to maintainers.
    const canonical = serializeBoard(canonicalBoard, '');
    const reparse = parseBoard(canonical);
    if (!reparse.board) {
      new Notice('Canonicalize aborted — round-trip parse failed.');
      log.error('canonicalize: round-trip parse failed', reparse.errors);
      return;
    }
    const afterShape = boardShape(reparse.board);
    if (!shapesEqual(beforeShape, afterShape)) {
      new Notice(
        'Canonicalize aborted — would have dropped data. See console.',
      );
      log.error('canonicalize: shape mismatch (data would be lost)', {
        before: beforeShape,
        after: afterShape,
      });
      return;
    }

    // Safe to commit. Push a single undo entry (pre-canonicalize board)
    // and apply the canonical bytes through the view.
    const store = view.getStore();
    const prev = store?.getState().board;
    if (prev) view.pushUndoSnapshot(prev);
    view.setViewData(canonical, false);
    (view as unknown as { requestSave: () => void }).requestSave();
    new Notice(
      `Canonicalized board · ${cardCount} card${cardCount === 1 ? '' : 's'} preserved.`,
    );
  }

  /**
   * Export the active board's dated cards to an `.ics` file written next to
   * the board (`My Board.md` → `My Board.ics`). Pro-gated. Offline-only — no
   * CalDAV push in v1. Idempotent: re-running overwrites the prior export.
   * Public so the Integrations settings pane can invoke it directly (the
   * command palette entry routes here too).
   */
  async exportActiveBoardICS(): Promise<void> {
    if (!licenseFSM.hasEntitlement('calendar')) {
      new Notice('Calendar export is a Kanban Pro feature.');
      this.openProSettings();
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(KanbanView);
    if (!view) {
      new Notice('Calendar export: open a Kanban board first.');
      return;
    }
    const board = view.getStore()?.getState().board;
    if (!board) {
      new Notice('Calendar export: no board loaded.');
      return;
    }
    let ics: string;
    try {
      ics = exportICS(board, { calendarName: view.file?.basename ?? 'Kanban' });
    } catch (err) {
      log.error('ics export: serialization failed', err);
      new Notice('Calendar export failed — see console.');
      return;
    }
    // `exportICS` returns '' when no card carries a due date. Surface that
    // clearly instead of writing an empty file — the old silent-no-op was
    // the user-visible half of the broken export (P2).
    if (!ics.trim()) {
      new Notice('Calendar export: no dated cards on this board to export.');
      return;
    }
    const boardPath = view.file?.path;
    if (!boardPath) {
      new Notice('Calendar export: board has no file path.');
      return;
    }
    const targetPath = boardPath.replace(/\.md$/i, '') + '.ics';
    try {
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, ics);
      } else {
        await this.app.vault.create(targetPath, ics);
      }
      new Notice(`Exported calendar to ${targetPath}`);
    } catch (err) {
      log.error('ics export: write failed', err);
      new Notice('Calendar export: could not write the .ics file — see console.');
    }
  }

  /**
   * Open Obsidian's Settings dialog directly on the Kanban Pro tab and
   * dispatch a focus-activation event so the Pro pane (if it ends up
   * being the first thing the user sees) brings the license-token input
   * to focus.
   *
   * Obsidian's `app.setting` is part of the informal/untyped surface
   * (`app.setting.open()`, `app.setting.openTabById(id)`). Per the
   * conventions in this file we cast as `unknown` rather than fight the
   * type system. If the API ever changes shape we fall back to a Notice
   * that points the user to the manual path — they can still get there.
   */
  openProSettings(): void {
    type SettingApi = {
      open?: () => void;
      openTabById?: (id: string) => void;
    };
    const setting = (this.app as unknown as { setting?: SettingApi }).setting;
    if (!setting?.open || !setting.openTabById) {
      // Fallback: keep the original guidance so users on a host whose
      // `app.setting` API has shifted still know where to go.
      new Notice('Open Settings → Kanban Pro → Pro to activate.');
      return;
    }
    // Pre-select Pro pane BEFORE display() runs (covers the case where
    // `setting.open()` mounts straight onto our tab).
    this.settingsTab?.openTo('pro');
    try {
      setting.open();
      setting.openTabById(this.manifest.id);
    } catch (err) {
      log.error('openProSettings failed', err);
      new Notice('Open Settings → Kanban Pro → Pro to activate.');
      return;
    }
    // Re-assert AFTER the tab is mounted. `openTabById` runs `display()`
    // (and a `hide()` on the previously-active tab resets `initialPaneIndex`
    // back to General/0), so a single pre-open `openTo` could land on
    // General — the "Activate lands on the wrong tab" bug. Now that the
    // pane is on screen, `openTo('pro')` uses the live `switchActive` hatch
    // to force the Pro pane regardless of what `display()` rendered first.
    this.settingsTab?.openTo('pro');
    // Best-effort: ask the Pro pane to focus its license-token input.
    // The pane registers a window listener for this event while it's
    // rendered; with openTo('pro') above, the pane is rendered by the
    // time this event fires (synchronous-ish), so the focus actually
    // lands — closing out the "Activate lands on General" gap.
    window.dispatchEvent(new CustomEvent('kanban-pro:focus-activation-field'));
  }

  private async openDashboard(): Promise<void> {
    const existing = this.app.workspace
      .getLeavesOfType(DASHBOARD_VIEW_TYPE)?.[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await (leaf as unknown as {
      setViewState: (s: { type: string; active?: boolean }) => Promise<void>;
    }).setViewState({
      type: DASHBOARD_VIEW_TYPE,
      active: true,
    });
  }

  private applyCompatClassToOpenLeaves(enabled: boolean): void {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const vt = leaf.view?.getViewType?.();
      if (vt !== KANBAN_VIEW_TYPE && vt !== DASHBOARD_VIEW_TYPE) return;
      // `containerEl` is on the view (or its ItemView base).
      const view = leaf.view as unknown as {
        containerEl?: HTMLElement;
      } | null;
      const el = view?.containerEl;
      if (!el) return;
      el.classList.toggle('kp-compat-mode', enabled);
    });
  }
}

/**
 * Shape guard.
 *
 * `canonicalizeActiveBoard` is allowed to renormalise whitespace, settings
 * block layout, and inline-meta token order — but it must NOT silently
 * delete cards or drop fields/meta values. This helper distills the parsed
 * board into the smallest structural snapshot we can compare before/after
 * the round-trip: lane titles, per-card text+done+sorted-meta. Anything
 * the canonicalizer corrupts (the assignee-loss bug, or an
 * "Untitled" card that gets pruned) shows up as a shape mismatch.
 */
interface CardShape {
  text: string;
  done: boolean;
  date: string;
  blockId: string;
  tags: string[];
  fields: Record<string, string>;
  subtaskCount: number;
}
interface LaneShape {
  title: string;
  kind: string;
  cards: CardShape[];
}
interface BoardShape {
  lanes: LaneShape[];
  totalCards: number;
}

function boardShape(board: import('@/core/model').Board): BoardShape {
  let totalCards = 0;
  const lanes: LaneShape[] = board.lanes.map((lane) => {
    const cards: CardShape[] = lane.cards.map((card) => {
      totalCards += 1;
      const tags = [...(card.meta.tags ?? [])].sort();
      const fields: Record<string, string> = {};
      const fieldKeys = Object.keys(card.meta.fields ?? {}).sort();
      for (const k of fieldKeys) fields[k] = card.meta.fields[k];
      return {
        text: card.text,
        done: card.done,
        date: card.meta.date ?? '',
        blockId: card.meta.blockId ?? '',
        tags,
        fields,
        subtaskCount: card.subtasks.length,
      };
    });
    return { title: lane.title, kind: lane.kind, cards };
  });
  return { lanes, totalCards };
}

function shapesEqual(a: BoardShape, b: BoardShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Count differing UTF-16 code units between two strings. Used by the
 * `Kanban: Validate board` Notice — we want a single integer that the
 * user can show me when they file a regression. This is intentionally
 * naive (character-wise compare with length padding) rather than a
 * proper byte-edit distance: a single insert near the top would inflate
 * the count, but the only signal this Notice needs is "is it zero
 * or not, and if not, roughly how big". `scripts/validate.mjs` does the
 * full per-line diff for the CLI case.
 */
function countByteDiff(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) diff += 1;
  }
  // `n` is referenced only for the inevitable "where did this number
  // come from" debug session — keep it eslint-visible.
  void n;
  return diff;
}

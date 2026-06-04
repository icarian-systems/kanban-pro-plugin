/**
 * First-run welcome modal.
 *
 * Two variants chosen at construction time:
 *
 *  - **fresh**: vault has zero kanban-format files. Primary CTA is
 *    "Create starter board" (generates `Welcome to Kanban Pro.md` with
 *    example cards that teach the drag-and-drop gesture by doing).
 *
 *  - **migrator**: vault already contains files with `kanban-plugin:
 *    board` frontmatter (existing `mgmeyers/obsidian-kanban` users).
 *    Reassure them their files are unchanged, primary CTA is "Open my
 *    boards" which routes to the same fuzzy picker used by the ribbon
 *    chooser.
 *
 * Dismissal is unified in `onClose()` — Obsidian fires that hook for
 * X / Esc / programmatic `close()` calls alike, so the
 * `hasSeenOnboarding` flag is flipped exactly once per dismissal,
 * regardless of which CTA (if any) the user clicked. Click handlers
 * just trigger their action and call `close()`; they never touch the
 * dismissal callback directly.
 *
 * UI is plain DOM (matching `CreateOrOpenBoardModal`) — no React mount
 * here because the body is a handful of buttons and a paragraph; the
 * cost of spinning up a root would dwarf the content.
 */
import { App, Modal } from 'obsidian';
import { PRO_FEATURES_LIST } from '@/shared/proCopy';

export type OnboardingVariant = 'fresh' | 'migrator';

export interface OnboardingModalCallbacks {
  /** Primary CTA for the **fresh** variant. */
  onCreateStarter: () => void | Promise<void>;
  /** Always available — generates an empty 3-lane board. */
  onCreateBlank: () => void | Promise<void>;
  /**
   * Fresh variant: opens the fuzzy picker over existing kanban files.
   * Migrator variant: same — that's the primary CTA there.
   */
  onOpenExisting: () => void;
  /**
   * Pro footer "Learn more" link. Dispatches the existing
   * `kanban-pro:open-pro-settings` event so the Settings → Pro pane
   * opens via the same channel `PaywallCard` uses.
   */
  onOpenProSettings: () => void;
  /**
   * Fired exactly once from `onClose()` for every dismissal path.
   * Implementations should flip `hasSeenOnboarding` and persist.
   */
  onDismiss: () => Promise<void> | void;
}

export class OnboardingModal extends Modal {
  private dismissed = false;

  constructor(
    app: App,
    private readonly variant: OnboardingVariant,
    private readonly migratorCount: number,
    private readonly cbs: OnboardingModalCallbacks,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass('kp-onboarding-modal');
    titleEl.setText('Welcome to Kanban Pro');
    contentEl.empty();

    const body = contentEl.createDiv({ cls: 'kp-onboarding-body' });

    if (this.variant === 'migrator') {
      this.renderMigratorBody(body);
    } else {
      this.renderFreshBody(body);
    }

    this.renderProFooter(contentEl);
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
    // Guard against re-entrant dismissals (Obsidian's lifecycle is
    // single-fire, but defensive code is cheap).
    if (this.dismissed) return;
    this.dismissed = true;
    await this.cbs.onDismiss();
  }

  // ──────────────────────────────────────────────────────────────────
  // Variant renderers
  // ──────────────────────────────────────────────────────────────────

  private renderFreshBody(host: HTMLElement): void {
    const lede = host.createEl('p', { cls: 'kp-onboarding-lede' });
    lede.setText(
      'Kanban boards stored as plain Markdown in your vault — drag cards between lanes, edit inline, undo with Cmd+Z.',
    );

    const actions = host.createDiv({ cls: 'kp-onboarding-actions' });

    const primary = actions.createEl('button', {
      cls: 'kp-onboarding-cta mod-cta',
      text: 'Create starter board',
    });
    primary.setAttr('aria-label', 'Create a starter board with example cards');
    primary.addEventListener('click', () => {
      this.close();
      void this.cbs.onCreateStarter();
    });

    const secondary = host.createDiv({ cls: 'kp-onboarding-secondary' });

    const blank = secondary.createEl('button', {
      cls: 'kp-onboarding-link',
      text: 'Create blank board',
    });
    blank.addEventListener('click', () => {
      this.close();
      void this.cbs.onCreateBlank();
    });

    const open = secondary.createEl('button', {
      cls: 'kp-onboarding-link',
      text: 'Open existing…',
    });
    open.addEventListener('click', () => {
      this.close();
      this.cbs.onOpenExisting();
    });

    // Autofocus the primary CTA so Enter creates immediately.
    setTimeout(() => primary.focus(), 0);
  }

  private renderMigratorBody(host: HTMLElement): void {
    const n = this.migratorCount;
    const plural = n === 1 ? '' : 's';
    const lede = host.createEl('p', { cls: 'kp-onboarding-lede' });
    lede.setText(
      `We found ${n} existing kanban board${plural} in your vault. Your files are unchanged — same format, same data.`,
    );

    const actions = host.createDiv({ cls: 'kp-onboarding-actions' });

    const primary = actions.createEl('button', {
      cls: 'kp-onboarding-cta mod-cta',
      text: 'Open my boards',
    });
    primary.setAttr(
      'aria-label',
      'Open the picker to choose one of your existing boards',
    );
    primary.addEventListener('click', () => {
      this.close();
      this.cbs.onOpenExisting();
    });

    const secondary = host.createDiv({ cls: 'kp-onboarding-secondary' });

    const blank = secondary.createEl('button', {
      cls: 'kp-onboarding-link',
      text: 'Create blank board',
    });
    blank.addEventListener('click', () => {
      this.close();
      void this.cbs.onCreateBlank();
    });

    setTimeout(() => primary.focus(), 0);
  }

  private renderProFooter(host: HTMLElement): void {
    const footer = host.createDiv({ cls: 'kp-onboarding-footer' });
    footer.createSpan({
      cls: 'kp-onboarding-footer-text',
      // Non-contradictory copy: the core board is free; Pro is the optional
      // add-on. (Old line both promised "Free is fully featured" AND listed
      // Pro-only unlocks, and the list had drifted from the other surfaces.)
      text: `The core board is free. Pro adds ${PRO_FEATURES_LIST}.`,
    });
    const learnMore = footer.createEl('button', {
      cls: 'kp-onboarding-footer-link',
      text: 'Learn more',
    });
    learnMore.setAttr('aria-label', 'Open Kanban Pro settings to learn more');
    learnMore.addEventListener('click', () => {
      this.cbs.onOpenProSettings();
      this.close();
    });
  }
}

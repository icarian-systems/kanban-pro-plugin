/**
 * Ribbon-entry modal — "Create a new board, or open an existing
 * kanban-formatted note?"
 *
 * Clicking the ribbon icon must present a chooser, not silently create a
 * file. This module owns that chooser plus a small fuzzy picker for the
 * "open existing" path.
 *
 * Lifecycle: both modals self-clean via Obsidian's `Modal` lifecycle —
 * `close()` removes the DOM. No additional teardown is needed.
 */
import { App, Modal, FuzzySuggestModal, TFile } from 'obsidian';
import { listExistingBoards } from './boardDiscovery';

export interface CreateOrOpenBoardModalCallbacks {
  /** Invoked when the user picks "Create new board". */
  onCreate: () => void | Promise<void>;
  /** Invoked when the user picks an existing kanban-formatted file. */
  onOpen: (file: TFile) => void | Promise<void>;
}

export class CreateOrOpenBoardModal extends Modal {
  constructor(app: App, private callbacks: CreateOrOpenBoardModalCallbacks) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Kanban Pro');
    contentEl.empty();

    const prompt = contentEl.createEl('p');
    prompt.setText(
      'Create a new board, or open an existing kanban-formatted note?',
    );

    const buttonRow = contentEl.createDiv({ cls: 'kp-modal-button-row' });
    buttonRow.style.display = 'flex';
    buttonRow.style.gap = '8px';
    buttonRow.style.marginTop = '12px';

    const createBtn = buttonRow.createEl('button', {
      text: 'Create new board',
      cls: 'mod-cta',
    });
    createBtn.addEventListener('click', () => {
      this.close();
      void this.callbacks.onCreate();
    });

    const openBtn = buttonRow.createEl('button', { text: 'Open existing…' });
    openBtn.addEventListener('click', () => {
      this.close();
      new ExistingBoardSuggestModal(this.app, this.callbacks.onOpen).open();
    });

    // Autofocus the primary action so Enter creates immediately.
    setTimeout(() => createBtn.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Fuzzy picker over every `.md` file in the vault whose metadata-cache
 * frontmatter contains `kanban-plugin: board`. We rely on the metadata
 * cache rather than reading file contents — same source of truth used by
 * the file-open routing hook in `main.ts`.
 *
 * Exported so the onboarding flow (`OnboardingModal` → "Open existing")
 * can reuse the same picker without re-implementing the lookup.
 */
export class ExistingBoardSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (file: TFile) => void | Promise<void>,
  ) {
    super(app);
    this.setPlaceholder('Search for a kanban-formatted note…');
  }

  override getItems(): TFile[] {
    return listExistingBoards(this.app);
  }

  override getItemText(file: TFile): string {
    return file.path;
  }

  override onChooseItem(file: TFile): void {
    void this.onPick(file);
  }
}

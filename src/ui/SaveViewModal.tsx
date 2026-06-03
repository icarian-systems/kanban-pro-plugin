/**
 * SaveViewModal — name-input prompt opened from the Views picker's
 * "Save current filter as…" button. Captures a single name string and
 * routes the result back through a callback; the caller (BoardRoot) is
 * responsible for snapshotting the current filter and calling
 * `savedViewStore.save({ name, filter })`.
 *
 * Lifecycle: self-cleans via Obsidian's `Modal` base — `close()` empties
 * `contentEl`. Same shape as `CreateOrOpenBoardModal`.
 */
import { App, Modal } from 'obsidian';

export interface SaveViewModalCallbacks {
  /** Invoked when the user confirms with a non-empty name. */
  onSubmit: (name: string) => void | Promise<void>;
  /** Optional pre-filled name. */
  initialName?: string;
}

export class SaveViewModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(app: App, private callbacks: SaveViewModalCallbacks) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Save current filter as…');
    contentEl.empty();

    const label = contentEl.createEl('label', {
      cls: 'kp-modal-label',
      text: 'Name',
    });
    label.style.display = 'block';
    label.style.marginBottom = '6px';
    label.style.fontSize = '12px';
    label.style.color = 'var(--text-muted)';

    const input = contentEl.createEl('input', {
      type: 'text',
      cls: 'kp-modal-input',
    });
    input.placeholder = 'My saved view';
    input.value = this.callbacks.initialName ?? '';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '6px 8px';
    input.style.marginBottom = '12px';
    this.inputEl = input;

    const buttonRow = contentEl.createDiv({ cls: 'kp-modal-button-row' });
    buttonRow.style.display = 'flex';
    buttonRow.style.justifyContent = 'flex-end';
    buttonRow.style.gap = '8px';

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', {
      text: 'Save',
      cls: 'mod-cta',
    });
    const submit = (): void => {
      const name = (this.inputEl?.value ?? '').trim();
      if (!name) {
        this.inputEl?.focus();
        return;
      }
      // Close first so the modal doesn't intercept focus or events fired
      // by the callback (e.g. a Notice). The callback is fire-and-forget
      // from the modal's perspective.
      this.close();
      void this.callbacks.onSubmit(name);
    };
    saveBtn.addEventListener('click', submit);

    // Enter submits.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
  }
}

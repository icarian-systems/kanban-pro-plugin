/**
 * General settings pane. Plain Obsidian Setting entries — no React mount.
 */
import { Setting } from 'obsidian';
import type { SettingsHost, PaneDisposerRegister } from '../SettingsTab';

// `register` is unused here (this pane has no live subscriptions), but
// every pane renderer takes the same `(root, host, register)` contract
// so the SettingsTab can wire them uniformly.
export function renderGeneralPane(
  root: HTMLElement,
  host: SettingsHost,
  _register: PaneDisposerRegister,
): void {
  void _register;
  const heading = document.createElement('h3');
  heading.textContent = 'General';
  root.appendChild(heading);

  new Setting(root)
    .setName('Default view mode')
    .setDesc('How new and unconfigured boards open: Board, Table, or List.')
    .addDropdown((dd: unknown) => {
      const d = dd as {
        addOption: (k: string, v: string) => unknown;
        setValue: (v: string) => unknown;
        onChange: (cb: (v: string) => void) => unknown;
      };
      d.addOption('board', 'Board');
      d.addOption('table', 'Table');
      d.addOption('list', 'List');
      d.setValue(host.settings.defaultView);
      d.onChange((value) => {
        host.settings.defaultView = value as 'board' | 'table' | 'list';
        void host.saveSettings();
      });
    });

  new Setting(root)
    .setName('Compatibility mode')
    .setDesc(
      'Restrict to features available in obsidian-kanban for migrating users. Recommended off.',
    )
    .addToggle((t: unknown) => {
      const tg = t as {
        setValue: (v: boolean) => unknown;
        onChange: (cb: (v: boolean) => void) => unknown;
      };
      tg.setValue(host.settings.compatibilityMode);
      tg.onChange((value) => {
        host.settings.compatibilityMode = value;
        // Notify open leaves so they can toggle the `.kp-compat-mode` class
        // without waiting for a settings-tab close.
        void host.saveSettings().then(() => {
          window.dispatchEvent(
            new CustomEvent('kanban-pro:compat-mode-changed', {
              detail: { enabled: value },
            }),
          );
        });
      });
    });

  new Setting(root)
    .setName('Archive cards with date')
    .setDesc('When checking a card, append a completion date in archive.')
    .addToggle((t: unknown) => {
      const tg = t as {
        setValue: (v: boolean) => unknown;
        onChange: (cb: (v: boolean) => void) => unknown;
      };
      tg.setValue(host.settings.archiveWithDate);
      tg.onChange((value) => {
        host.settings.archiveWithDate = value;
        void host.saveSettings();
      });
    });
}

/**
 * Appearance settings pane.
 */
import { Setting } from 'obsidian';
import type { SettingsHost, PaneDisposerRegister } from '../SettingsTab';

export function renderAppearancePane(
  root: HTMLElement,
  host: SettingsHost,
  _register: PaneDisposerRegister,
): void {
  void _register;
  const heading = document.createElement('h3');
  heading.textContent = 'Appearance';
  root.appendChild(heading);

  new Setting(root)
    .setName('Lane width')
    .setDesc('Width of a single lane in pixels.')
    .addText((t: unknown) => {
      const tx = t as {
        setValue: (v: string) => unknown;
        onChange: (cb: (v: string) => void) => unknown;
        setPlaceholder?: (p: string) => unknown;
      };
      tx.setPlaceholder?.('272');
      tx.setValue(String(host.settings.laneWidth));
      tx.onChange((value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 100 && n < 1200) {
          host.settings.laneWidth = n;
          void host.saveSettings();
        }
      });
    });
}

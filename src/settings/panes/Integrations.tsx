/**
 * Integrations settings pane. Calendar (.ics) export.
 *
 * v1 ships offline calendar export only. GitHub Issues sync is a post-1.0
 * roadmap feature (`src/pro/integrations/github` is a deliberate stub) and is
 * intentionally NOT surfaced here — we don't show a Pro affordance for
 * something that can't be used yet.
 */
import { Notice, Setting } from 'obsidian';
import { licenseFSM } from '@/pro/license/state';
import type { SettingsHost, PaneDisposerRegister } from '../SettingsTab';

/**
 * Inserts a small `PRO` pill into the name element of an Obsidian Setting row.
 * Reuses the same visual treatment as the board subnav's `.kp-pro-chip`, so
 * the badge looks identical across the plugin. The badge is appended to the
 * name span rather than the row itself so it sits inline next to the title.
 */
function addProBadge(setting: { nameEl?: HTMLElement; settingEl?: HTMLElement }): void {
  const target = setting.nameEl ?? setting.settingEl;
  if (!target) return;
  const badge = document.createElement('span');
  badge.className = 'kp-pro-chip';
  badge.setAttribute('aria-label', 'Pro feature');
  badge.textContent = 'Pro';
  target.appendChild(badge);
}

export function renderIntegrationsPane(
  root: HTMLElement,
  host: SettingsHost,
  register: PaneDisposerRegister,
): void {
  const heading = document.createElement('h3');
  heading.textContent = 'Integrations';
  root.appendChild(heading);

  // Read license state directly from the FSM (no React hook here — this is
  // a plain DOM pane). We re-render the pro-gated controls on subscribe so
  // upgrade flow (Pro tab → Activate) immediately enables Connect / toggle
  // without requiring the user to switch tabs.
  const isPro = (): boolean => licenseFSM.getGate().tier === 'pro';

  // Calendar (.ics) export — Pro. The button triggers the plugin's
  // `exportActiveBoardICS()` (same code path as the "Export board to calendar
  // (.ics)" command), which writes an .ics next to the active board file.
  let calendarButtonEl: HTMLButtonElement | null = null;
  const calendarSetting = new Setting(root)
    .setName('Calendar (.ics) export')
    .setDesc('Export the active board\'s dated cards to an .ics file next to it. Also available from the command palette.')
    .addButton((b: unknown) => {
      const btn = b as {
        setButtonText: (s: string) => unknown;
        setCta?: () => unknown;
        onClick: (cb: () => void) => unknown;
        buttonEl?: HTMLButtonElement;
      };
      btn.setButtonText('Export .ics');
      btn.onClick(async () => {
        if (!isPro()) return; // belt + braces — the button is disabled for free
        const plugin = host.plugin as unknown as {
          exportActiveBoardICS?: () => Promise<void> | void;
        };
        if (plugin.exportActiveBoardICS) {
          await plugin.exportActiveBoardICS();
        } else {
          new Notice('Calendar export is unavailable — please reload the plugin.');
        }
      });
      calendarButtonEl = btn.buttonEl ?? null;
    }) as unknown as { nameEl?: HTMLElement; settingEl?: HTMLElement };
  addProBadge(calendarSetting);

  // Apply the disabled-when-free state. Re-run whenever the FSM transitions
  // (e.g. user activates a license on the Pro tab and pops back here).
  const applyGate = (): void => {
    const pro = isPro();
    if (calendarButtonEl) {
      calendarButtonEl.disabled = !pro;
      calendarButtonEl.classList.toggle('is-pro-locked', !pro);
      calendarButtonEl.title = pro
        ? ''
        : 'Activate Kanban Pro to export calendars.';
    }
    // Tag the row so CSS can dim the description / chip when locked. Mirrors
    // the `.kp-setting.is-pro.is-locked` rule already in src/styles/settings.css.
    const calendarEl = (calendarSetting as { settingEl?: HTMLElement }).settingEl;
    calendarEl?.classList.toggle('is-pro-locked', !pro);
  };
  applyGate();
  const unsub = licenseFSM.subscribe(applyGate);
  register(unsub);
}

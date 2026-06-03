/**
 * Pro settings pane — license activation, status, revalidation.
 *
 * License operations route through `licenseFSM` (owned by Integrations).
 * This pane is the only place free-tier users touch the license module;
 * other Pro features import `useProGate()` and render a paywall card
 * when `tier === 'free'`.
 */
import { Setting } from 'obsidian';
import { licenseFSM } from '@/pro/license/state';
import { openCheckout } from '@/pro/license/checkout';
import type { ProGate } from '@/pro/license/state';
import { log } from '@/shared/log';
import type { SettingsHost, PaneDisposerRegister } from '../SettingsTab';

/**
 * Custom DOM event the plugin's `main.ts` dispatches when the
 * "Activate Pro license" command opens Settings → Pro. The Pro pane
 * listens for it and focuses the license-token input so the user can
 * paste immediately.
 */
const FOCUS_ACTIVATION_EVENT = 'kanban-pro:focus-activation-field';

export function renderProPane(
  root: HTMLElement,
  host: SettingsHost,
  register: PaneDisposerRegister,
): void {
  const heading = document.createElement('h3');
  heading.textContent = 'Pro';
  root.appendChild(heading);

  // Status badge — reads from the licenseFSM. Re-renders on subscribe.
  const statusRow = document.createElement('div');
  statusRow.className = 'kanban-pro-license-status';
  root.appendChild(statusRow);

  // Deactivate and Revalidate live inside this licensed-only block.
  // When status is `Free · unlicensed` we hide them so the pane shows only
  // the activation affordance (token field + Activate). The block is
  // re-shown/-hidden in `renderStatus()` as the FSM transitions in/out of
  // unlicensed without rebuilding the pane.
  const licensedOnlyBlock = document.createElement('div');
  licensedOnlyBlock.className = 'kanban-pro-licensed-only';
  // Appended after the token field below; created here so renderStatus can
  // reference it from the closure on the very first call.

  // Inverse of licensedOnlyBlock — the "buy a license" affordance, shown
  // ONLY while free + unlicensed. Once a license is active the purchase CTA
  // is noise, so renderStatus() hides it on the same transition that reveals
  // the Deactivate/Revalidate block. Created here so renderStatus can toggle
  // it from the closure before it's populated below.
  const purchaseBlock = document.createElement('div');
  purchaseBlock.className = 'kanban-pro-purchase';

  const renderStatus = () => {
    const gate = licenseFSM.getGate();
    statusRow.empty?.();
    while (statusRow.firstChild) statusRow.removeChild(statusRow.firstChild);
    const label = document.createElement('strong');
    label.textContent = 'License status: ';
    const badge = document.createElement('span');
    badge.className = `kanban-pro-license-badge is-${gate.state}`;
    badge.textContent = `${gate.tier === 'pro' ? 'Pro' : 'Free'} · ${gate.state}`;
    statusRow.appendChild(label);
    statusRow.appendChild(badge);

    // Toggle the Deactivate/Revalidate block. The trigger is the
    // composite display string the FSM exposes through tier+state; we treat
    // anything other than free+unlicensed as "has a license to manage".
    const isUnlicensed = gate.tier === 'free' && gate.state === 'unlicensed';
    licensedOnlyBlock.style.display = isUnlicensed ? 'none' : '';
    purchaseBlock.style.display = isUnlicensed ? '' : 'none';
  };
  renderStatus();
  // Subscribe to license FSM; the SettingsTab owns disposer lifecycle and
  // runs the returned `unsub` in `hide()`. This replaces the previous
  // MutationObserver-on-parentNode pattern, which threw when `root` was
  // unattached at mount time and left the modal in a half-rendered state
  // that captured pointer events without dispatching.
  const unsub = licenseFSM.subscribe(renderStatus);
  register(unsub);

  // Two-field activation: email + license key. The FSM accepts either
  // ActivationParams or a legacy pipe-delimited string; we always pass the
  // object form from here. The legacy string path is retained for the
  // `kanban-pro-license-activate` command's `settings.licenseToken`
  // fall-back (older data.json files).
  let emailBuffer = '';
  let keyBuffer = '';
  // Captured so the `kanban-pro:focus-activation-field` event handler can
  // focus the underlying input on command invocation.
  let emailInputEl: HTMLInputElement | null = null;
  // Inline error row — mounted after the key Setting; shown only when the
  // most recent activation attempt did not produce a Pro license. We reuse
  // the existing `.kp-activation-error` token from paywall.css so the styling
  // matches the in-app PaywallCard error.
  const errorRow = document.createElement('div');
  errorRow.className = 'kp-activation-error';
  errorRow.setAttribute('role', 'alert');
  errorRow.style.display = 'none';
  const clearError = () => {
    if (errorRow.style.display !== 'none') {
      errorRow.style.display = 'none';
      errorRow.textContent = '';
    }
  };

  // Purchase affordance — mounted above the activation fields so a Free user
  // sees "buy" before "paste your key". Opens the Lemon Squeezy checkout in
  // the OS browser; on return they paste the emailed key into the fields
  // below. Hidden once licensed (see renderStatus).
  root.appendChild(purchaseBlock);
  new Setting(purchaseBlock)
    .setName('Get Kanban Pro')
    .setDesc('Unlock recurrence, saved views, time tracking, calendar, and the dashboard.')
    .addButton((b: unknown) => {
      const btn = b as {
        setButtonText: (s: string) => unknown;
        setCta?: () => unknown;
        onClick: (cb: () => void) => unknown;
      };
      btn.setButtonText('Buy a license');
      btn.setCta?.();
      btn.onClick(() => openCheckout());
    });

  new Setting(root)
    .setName('License email')
    .setDesc('The email you used at Lemon Squeezy checkout.')
    .addText((t: unknown) => {
      const tx = t as {
        setValue: (v: string) => unknown;
        setPlaceholder?: (p: string) => unknown;
        onChange: (cb: (v: string) => void) => unknown;
        inputEl?: HTMLInputElement;
      };
      tx.setPlaceholder?.('you@example.com');
      tx.onChange((value) => {
        emailBuffer = value.trim();
        clearError();
      });
      emailInputEl = tx.inputEl ?? null;
      if (emailInputEl) {
        emailInputEl.type = 'email';
        emailInputEl.autocomplete = 'email';
      }
    });
  new Setting(root)
    .setName('License key')
    .setDesc('The license key from your Lemon Squeezy receipt email.')
    .addText((t: unknown) => {
      const tx = t as {
        setValue: (v: string) => unknown;
        setPlaceholder?: (p: string) => unknown;
        onChange: (cb: (v: string) => void) => unknown;
        inputEl?: HTMLInputElement;
      };
      tx.setPlaceholder?.('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX');
      tx.onChange((value) => {
        keyBuffer = value.trim();
        clearError();
      });
    })
    .addButton((b: unknown) => {
      const btn = b as {
        setButtonText: (s: string) => unknown;
        setCta?: () => unknown;
        onClick: (cb: () => void) => unknown;
      };
      btn.setButtonText('Activate');
      btn.setCta?.();
      btn.onClick(async () => {
        if (!emailBuffer || !keyBuffer) {
          errorRow.textContent = 'Enter both your license email and key.';
          errorRow.style.display = '';
          return;
        }
        try {
          // Route through the FSM. On success the FSM commits the
          // PersistedLicense (signed token + exp + lastValidatedAt) via
          // the persistence channel attached in `main.ts.onload`. We MUST
          // NOT write `host.settings.licenseToken` here — doing so was a
          // bug where the raw `email|key` input was being
          // saved instead of the server-signed token, and cold start
          // could never auto-activate.
          const gate = await licenseFSM.activate({ email: emailBuffer, key: keyBuffer });
          log.info('license activation result:', gate);
          // If the gate did not move to pro, surface the most relevant error
          // message. Prefer the FSM-attached `lastError.message` on the
          // ProGate shape; fall back to a generic
          // hint when the field isn't present yet.
          const failed = gate?.tier !== 'pro';
          if (failed) {
            const gateWithError = gate as ProGate & { lastError?: { message: string; at: number } };
            const message = gateWithError.lastError?.message
              ?? 'Activation failed — check your email and key, or your network connection.';
            errorRow.textContent = message;
            errorRow.style.display = '';
          } else {
            errorRow.style.display = 'none';
            errorRow.textContent = '';
            // Scrub the legacy raw `email|key` field on success. The FSM
            // already persists the signed token via `persistedLicense`, but
            // `licenseToken` from older data.json files (or from a previous
            // 1.0.0 install where the Pro pane wrote the raw input) would
            // otherwise sit on disk forever, and the
            // `kanban-pro-license-activate` command's fall-back path would
            // happily re-exchange the (now-stale) raw key on every cold
            // start. Mirror the Deactivate handler's clean-up below so both
            // success-paths leave `data.json` in a canonical shape.
            host.settings.licenseToken = null;
            await host.saveSettings();
          }
        } catch (err) {
          log.error('license activation failed', err);
          const message = err instanceof Error && err.message
            ? err.message
            : 'Activation failed — check your email and key, or your network connection.';
          errorRow.textContent = message;
          errorRow.style.display = '';
        }
      });
    });
  // Mount the error row directly after the token Setting so it sits between
  // the input row and the licensed-only block.
  root.appendChild(errorRow);

  // Listen for the focus-activation request dispatched by the
  // "Activate Pro license" command (main.ts). Disposer torn down via the
  // SettingsTab's `hide()` path.
  const onFocusActivation = (): void => {
    emailInputEl?.focus?.();
    emailInputEl?.select?.();
  };
  window.addEventListener(FOCUS_ACTIVATION_EVENT, onFocusActivation);
  register(() => window.removeEventListener(FOCUS_ACTIVATION_EVENT, onFocusActivation));

  // Mount the licensed-only block after the token row, then attach
  // Revalidate / Deactivate inside it. renderStatus() flips its
  // display based on FSM state — see the comment above.
  root.appendChild(licensedOnlyBlock);

  new Setting(licensedOnlyBlock)
    .setName('Revalidate now')
    .setDesc('Re-check your license against the server. Pro automatically revalidates weekly.')
    .addButton((b: unknown) => {
      const btn = b as {
        setButtonText: (s: string) => unknown;
        onClick: (cb: () => void) => unknown;
      };
      btn.setButtonText('Revalidate');
      btn.onClick(async () => {
        try {
          await licenseFSM.revalidate();
        } catch (err) {
          log.error('license revalidation failed', err);
        }
      });
    });

  new Setting(licensedOnlyBlock)
    .setName('Deactivate')
    .setDesc('Remove the license from this install. Your data is preserved.')
    .addButton((b: unknown) => {
      const btn = b as {
        setButtonText: (s: string) => unknown;
        setWarning?: () => unknown;
        onClick: (cb: () => void) => unknown;
      };
      btn.setButtonText('Deactivate');
      btn.setWarning?.();
      btn.onClick(async () => {
        try {
          // FSM commits `persistedLicense = null` through the attached
          // persistence channel. Clear the legacy raw-input field too so
          // the Activate command (which falls back to `licenseToken` for
          // keyboard-only re-activation) doesn't silently re-enable
          // after a deactivate.
          await licenseFSM.deactivate();
          host.settings.licenseToken = null;
          await host.saveSettings();
        } catch (err) {
          log.error('license deactivation failed', err);
        }
      });
    });

  // Apply the current gate-driven visibility now that the block has been
  // populated. The initial call earlier in renderStatus() may have run
  // before the block had its children — re-run to be safe.
  renderStatus();
}

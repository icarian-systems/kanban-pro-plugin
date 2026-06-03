/**
 * PaywallCard — rendered in place of a Pro feature when the user is on the
 * free tier. Consumers gate via:
 *
 *   const gate = useProGate();
 *   return gate.tier === 'pro' ? <RecurrenceEditor … /> : <PaywallCard … />;
 *
 * The button dispatches a custom event the host can listen for to open the
 * settings tab on the Pro pane — `main.ts` wires `window.addEventListener(
 * 'kanban-pro:open-pro-settings', …)`.
 */
import * as React from 'react';
import { openCheckout } from '@/pro/license/checkout';

export interface PaywallCardProps {
  /** Short feature name, e.g. "Recurrence", "Saved Views". */
  feature: string;
  /** One- or two-sentence description of what unlocking enables. */
  description?: string;
  /** Optional CTA override; defaults to "Activate Kanban Pro". */
  ctaLabel?: string;
  /** Optional icon to render to the left of the title. */
  icon?: React.ReactNode;
  /** Compact variant for inline gating inside small containers. */
  compact?: boolean;
  /**
   * Layout hint for narrow hosts (right rail, DetailPanel side column).
   * `"stack"` keeps head / body / action stacked vertically so the CTA
   * never clips at ~260px host widths. Defaults to auto (inherits whatever
   * the `compact` variant's flex direction is).
   */
  layout?: 'auto' | 'stack';
}

export const PaywallCard: React.FC<PaywallCardProps> = ({
  feature,
  description,
  ctaLabel = 'Activate Kanban Pro',
  icon,
  compact = false,
  layout = 'auto',
}) => {
  const handleClick = React.useCallback(() => {
    // Decouple: the plugin's settings tab listens for this and opens itself.
    const ev = new CustomEvent('kanban-pro:open-pro-settings', { detail: { feature } });
    window.dispatchEvent(ev);
  }, [feature]);

  // Secondary path for users who don't yet own a license: jump straight to
  // the Lemon Squeezy checkout instead of the (key-entry) settings pane.
  const handleBuy = React.useCallback(() => {
    openCheckout();
  }, []);

  const className =
    'kp-paywall'
    + (compact ? ' is-inline' : '')
    + (layout === 'stack' ? ' is-stacked' : '');

  return (
    <div
      className={className}
      role="region"
      aria-label={`${feature} (Pro)`}
    >
      <div className="kp-paywall-head">
        {icon != null ? <span className="kp-paywall-icon" aria-hidden="true">{icon}</span> : null}
        <span className="kp-paywall-title">{feature}</span>
        <span className="kp-paywall-badge">Pro</span>
      </div>
      {description ? <p className="kp-paywall-body">{description}</p> : null}
      <div className="kp-paywall-actions">
        <button
          type="button"
          className="kp-paywall-cta"
          onClick={handleClick}
          aria-label={ctaLabel}
        >
          {ctaLabel}
        </button>
        <button
          type="button"
          className="kp-paywall-link"
          onClick={handleBuy}
          aria-label="Buy a Kanban Pro license"
        >
          Buy a license
        </button>
      </div>
    </div>
  );
};

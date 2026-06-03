/**
 * Lemon Squeezy checkout (purchase) URL for Kanban Pro.
 *
 * This is the public store checkout where a Free-tier user BUYS a license.
 * It is deliberately distinct from the license SERVER (`remote.ts`), which
 * exchanges an already-purchased key for a signed offline token. The two
 * never share a host: the store is Lemon Squeezy's domain; the server is our
 * Cloudflare Worker.
 *
 * Reached from the Pro settings pane ("Get Kanban Pro") and the in-app
 * paywall CTA ("Buy a license").
 */
export const CHECKOUT_URL =
  'https://icarian-systems.lemonsqueezy.com/checkout/buy/d404fb1f-3961-4a3a-9715-8eb4d784fa5e';

/**
 * Open the checkout in the user's default browser. Obsidian intercepts
 * `window.open` for http(s) URLs and routes them to the OS browser (works on
 * desktop and mobile), so this is the sanctioned way to leave the app — we do
 * NOT touch Electron's `shell` directly (would break the mobile build and the
 * plugin-review constraints in `shared/obsidian.ts`).
 */
export function openCheckout(): void {
  window.open(CHECKOUT_URL, '_blank');
}

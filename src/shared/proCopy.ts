/**
 * Canonical Pro feature copy.
 *
 * Single source of truth for "what does Pro unlock?" so every surface — the
 * onboarding modal footer, the right-rail "Explore Pro" card, the Pro
 * settings pane, and any future paywall — reads the SAME list. Previously
 * each surface hand-wrote its own list and they drifted (one said
 * "integrations", another "calendar, and the dashboard", the modal only
 * mentioned "Recurrence and Saved Views"). Keep this in sync with
 * `V1_PRO_ENTITLEMENTS` in `src/pro/license/state.ts`.
 */

/** Lower-case feature list for inline use ("Unlock <PRO_FEATURES_LIST>."). */
export const PRO_FEATURES_LIST =
  'recurrence, saved views, time tracking, calendar export, and the dashboard';

/** A complete one-sentence pitch used by the right-rail Explore Pro card. */
export const PRO_FEATURES_SENTENCE = `Kanban Pro adds ${PRO_FEATURES_LIST}.`;

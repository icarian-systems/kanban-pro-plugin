/**
 * Plugin identity constants.
 *
 * Single source of truth for the plugin's manifest `id`. This value is used
 * for two host-facing lookups that MUST agree with `manifest.json`:
 *
 *   1. `app.plugins.plugins[<id>]` — the registry key under which Obsidian
 *      stores our plugin instance. KanbanView probes this to reach the
 *      plugin-owned Saved Views / Tracking stores without importing the
 *      plugin class (which would invert the module graph).
 *   2. Command-id prefixing — Obsidian namespaces every command as
 *      `<pluginId>:<commandId>`, so `executeCommandById` needs the prefix.
 *
 * Historically these were hard-coded to the string `'kanban-pro'`, which is
 * the *view type* (see `KANBAN_VIEW_TYPE`), NOT the manifest id. The manifest
 * id is `kanban-pro-boards`. The mismatch silently broke the plugin-registry
 * lookups (Tracking + Saved Views stores resolved to `null`) and the toolbar
 * Dashboard button's command dispatch. Keep this constant in lock-step with
 * `manifest.json#id`.
 */
export const KANBAN_PRO_PLUGIN_ID = 'kanban-pro-boards';

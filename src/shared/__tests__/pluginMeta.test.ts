import { describe, it, expect } from 'vitest';
import { KANBAN_PRO_PLUGIN_ID } from '../pluginMeta';
import manifest from '../../../manifest.json';

/**
 * Regression guard for the root cause behind three QA bugs (time-tracking
 * pill never rendered, saved views couldn't persist, the toolbar Dashboard
 * button did nothing): the plugin-registry key / command-id prefix had
 * drifted from the manifest id (`kanban-pro` vs `kanban-pro-boards`).
 *
 * If someone renames the plugin in manifest.json without updating this
 * constant, this test fails loudly instead of silently re-breaking the
 * `app.plugins.plugins[id]` lookups and command dispatch.
 */
describe('KANBAN_PRO_PLUGIN_ID', () => {
  it('matches manifest.json id', () => {
    expect(KANBAN_PRO_PLUGIN_ID).toBe((manifest as { id: string }).id);
  });
});

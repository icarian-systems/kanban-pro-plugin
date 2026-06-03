/**
 * Bases adapter.
 *
 * Bases is Obsidian's first-party "database view" plugin. Its public API has
 * not stabilised at time of writing, so this adapter is intentionally
 * conservative:
 *
 *   1. Detect via the standard `app.plugins.plugins.bases` lookup.
 *   2. Expose `available()` so callers can branch UI without throwing.
 *   3. The `query()` implementation is a TODO stub — once Bases lands a
 *      documented `runQuery` (or equivalent) we wire it through. Until then
 *      we route through our local `executeQuery` over an empty index; the
 *      dashboard view treats `[]` as "fall back to the vault-index engine".
 */

import type { BasesAdapter, VaultIndexEntryShape } from './types';
import { log } from '@/shared/log';

const BASES_PLUGIN_ID = 'bases';

interface PluginsHost {
  plugins?: {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
  };
  internalPlugins?: {
    plugins?: Record<string, { enabled?: boolean; instance?: unknown }>;
  };
}

export function createBasesAdapter(app: import('obsidian').App): BasesAdapter {
  return {
    available(): boolean {
      return isBasesLoaded(app);
    },
    query(spec: unknown): VaultIndexEntryShape[] {
      if (!isBasesLoaded(app)) return [];
      // TODO: route `spec` through Bases' public API once it stabilises.
      // For v1 we no-op so callers always fall through to the local engine.
      log.debug('basesAdapter.query stub invoked', spec);
      return [];
    },
  };
}

function isBasesLoaded(app: import('obsidian').App | undefined): boolean {
  if (!app) return false;
  const host = app as unknown as PluginsHost;
  // Community plugin path.
  const community = host.plugins?.plugins?.[BASES_PLUGIN_ID];
  if (community) return true;
  // Bases is shipping as a core/internal plugin in 1.9+. Check both.
  const internal = host.internalPlugins?.plugins?.[BASES_PLUGIN_ID];
  if (internal && internal.enabled) return true;
  // `enabledPlugins` is the v1.4+ enabled-id set for community plugins.
  if (host.plugins?.enabledPlugins?.has(BASES_PLUGIN_ID)) return true;
  return false;
}

/**
 * Templater bridge.
 *
 * We do NOT bundle Templater. At runtime we detect the installed plugin and,
 * if present, route the body through its public API. Any failure (missing
 * plugin, missing API method, runtime throw) is caught and surfaced via a
 * sentinel return value — callers fall back to the basic expander.
 */

import { log } from '@/shared/log';

const TEMPLATER_PLUGIN_ID = 'templater-obsidian';

/**
 * Minimal shape of the Templater plugin we touch. Templater's API has shifted
 * across releases; we feature-detect every method before calling it.
 */
interface TemplaterLike {
  templater?: {
    parse_template?: (config: unknown, body: string) => Promise<string> | string;
    parseTemplate?: (config: unknown, body: string) => Promise<string> | string;
    create_running_config?: (
      template_file: unknown,
      target_file: unknown,
      run_mode: unknown,
    ) => unknown;
  };
  // Some forks expose parseTemplate on the plugin instance directly.
  parseTemplate?: (body: string, file?: unknown) => Promise<string> | string;
}

/** Returns true if the Templater plugin appears to be installed and loaded. */
export function isTemplaterAvailable(app: import('obsidian').App | undefined): boolean {
  if (!app) return false;
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
  return Boolean(plugins?.plugins?.[TEMPLATER_PLUGIN_ID]);
}

function getTemplaterPlugin(
  app: import('obsidian').App | undefined,
): TemplaterLike | undefined {
  if (!app) return undefined;
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, TemplaterLike> } })
    .plugins;
  return plugins?.plugins?.[TEMPLATER_PLUGIN_ID];
}

/**
 * Result discriminator: { ok: true, text } if Templater handled it, else
 * { ok: false } so the caller falls back to basic substitution.
 */
export type TemplaterResult = { ok: true; text: string } | { ok: false; reason: string };

export async function runThroughTemplater(
  body: string,
  app: import('obsidian').App | undefined,
): Promise<TemplaterResult> {
  const plugin = getTemplaterPlugin(app);
  if (!plugin) return { ok: false, reason: 'templater-not-installed' };
  try {
    // Try the modern API surface first.
    const inner = plugin.templater;
    if (inner) {
      // create_running_config requires (template_file, target_file, run_mode).
      // We don't have a host file in the abstract template expansion path, so
      // we pass undefined and rely on Templater's DynamicCommand mode if the
      // installed version supports it. Many Templater versions ignore the
      // config for ad-hoc parse calls.
      const config = inner.create_running_config
        ? safeCall(() => inner.create_running_config!(undefined, undefined, 0))
        : undefined;

      if (typeof inner.parse_template === 'function') {
        const out = await inner.parse_template(config, body);
        return { ok: true, text: String(out) };
      }
      if (typeof inner.parseTemplate === 'function') {
        const out = await inner.parseTemplate(config, body);
        return { ok: true, text: String(out) };
      }
    }
    if (typeof plugin.parseTemplate === 'function') {
      const out = await plugin.parseTemplate(body);
      return { ok: true, text: String(out) };
    }
    return { ok: false, reason: 'templater-api-unknown' };
  } catch (e) {
    log.warn('templater bridge failure, falling back', e);
    return { ok: false, reason: 'templater-threw' };
  }
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

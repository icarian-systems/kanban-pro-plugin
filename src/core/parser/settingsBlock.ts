/**
 * Settings block extractor / injector.
 *
 * The Kanban settings block looks like:
 *
 *    %% kanban:settings %%
 *    ```
 *    {
 *      "kanban-plugin": "board",
 *      "lane-width": 272
 *    }
 *    ```
 *    %%
 *
 * The parser owns this block. Unknown keys are preserved verbatim
 * at the end of the object so plugin upgrades and forward-compat
 * features don't lose data. Stable key order is enforced on write
 * (canonicalize) but never enforced on read.
 *
 * This module is pure — it does not depend on remark or obsidian.
 * Settings are located via `sentinels.findSettings()`; this file
 * handles only JSON parse / re-serialize.
 */
import type { BoardSettings, ParseError } from '@/core/model';

/** Stable key order used by `serializeSettings`. */
const KNOWN_KEY_ORDER: string[] = [
  'kanban-plugin',
  'kanban-canonical',
  'default-view',
  'date-format',
  'time-format',
  'lane-width',
  'allow-embed-edit',
  'archive-with-date',
];

export interface ParsedSettings {
  settings: BoardSettings;
  errors: ParseError[];
}

export function parseSettingsJson(json: string, byteStart = 0): ParsedSettings {
  const errors: ParseError[] = [];
  const trimmed = json.trim();
  if (trimmed === '') {
    return { settings: {}, errors };
  }
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      errors.push({
        message: 'Settings block must contain a JSON object',
        severity: 'error',
        position: { start: byteStart, end: byteStart + json.length },
      });
      return { settings: {}, errors };
    }
    return { settings: obj as BoardSettings, errors };
  } catch (e) {
    errors.push({
      message: `Settings JSON parse failed: ${(e as Error).message}`,
      severity: 'error',
      position: { start: byteStart, end: byteStart + json.length },
    });
    return { settings: {}, errors };
  }
}

/**
 * Serialize a settings record to the canonical wire JSON.
 *
 * - Known keys come first, in `KNOWN_KEY_ORDER`.
 * - Unknown keys are appended in insertion order so we preserve
 *   any forward-compat keys the user (or a newer plugin version)
 *   wrote into the file.
 * - Output is 2-space indented to match the incumbent's style.
 */
export function serializeSettings(settings: BoardSettings): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_KEY_ORDER) {
    if (settings[key] !== undefined) ordered[key] = settings[key];
  }
  for (const key of Object.keys(settings)) {
    if (key in ordered) continue;
    ordered[key] = settings[key];
  }
  return JSON.stringify(ordered, null, 2);
}

/**
 * Render the entire `%% kanban:settings ... %%` sentinel block,
 * given the JSON body. Used by the canonicalizer and as a fallback
 * when the original settings block has been mutated.
 *
 * Form: a single multi-line Obsidian comment. The opening `%%` lives
 * on its own line so the fenced JSON inside is rendered as part of
 * the comment (i.e. invisible in source mode), not as a visible code
 * block. The legacy `%% kanban:settings %%` (with inline closer) is
 * still accepted on parse for compatibility with files written by
 * older versions of mgmeyers/obsidian-kanban.
 */
export function renderSettingsBlock(settings: BoardSettings, newline = '\n'): string {
  const body = serializeSettings(settings);
  return ['%% kanban:settings', '```', body, '```', '%%'].join(newline) + newline;
}

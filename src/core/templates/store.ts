/**
 * Persisted template store backed by plugin.saveData.
 *
 * Persistence shape:
 *   plugin.loadData() → { ...settings, templates: BasicTemplate[] }
 * We isolate templates under a sub-key so the existing settings load/save
 * paths in main.ts continue to round-trip unchanged.
 *
 * The store maintains an in-memory list separate from the on-disk array;
 * subscribers are notified on every successful upsert/remove. Seed
 * templates (Bug report / Feature request / Standup item) are merged in
 * the first time the user opens a Kanban view and no templates have been
 * persisted yet.
 */
import type { Plugin } from 'obsidian';
import type {
  BasicTemplate,
  ExpandContext,
  ExpandedTemplate,
  TemplateStore,
} from './types';
import { expandTemplate } from './expand';

const TEMPLATES_KEY = 'templates';

/** The three Free seed templates the architecture calls out as table-stakes. */
export const SEED_TEMPLATES: BasicTemplate[] = [
  {
    id: 'seed-bug-report',
    name: 'Bug report',
    description: 'Reproduction steps + expected/actual.',
    body: [
      '**Bug:** {{cursor}}',
      '',
      '- **Steps:**',
      '  1. ',
      '- **Expected:** ',
      '- **Actual:** ',
      '- **Env:** ',
    ].join('\n'),
    meta: { tags: ['bug'] },
  },
  {
    id: 'seed-feature-request',
    name: 'Feature request',
    description: 'User story + acceptance criteria.',
    body: [
      '**Feature:** {{cursor}}',
      '',
      '- **Why:** ',
      '- **Acceptance:**',
      '  - [ ] ',
    ].join('\n'),
    meta: { tags: ['feature'] },
  },
  {
    id: 'seed-standup-item',
    name: 'Standup item',
    description: 'Yesterday / Today / Blockers — date-stamped.',
    body: [
      '**Standup {{date}}**',
      '',
      '- **Yesterday:** {{cursor}}',
      '- **Today:** ',
      '- **Blockers:** ',
    ].join('\n'),
    meta: { tags: ['standup'] },
  },
];

interface PluginData {
  [TEMPLATES_KEY]?: BasicTemplate[];
  [key: string]: unknown;
}

/**
 * Read the persisted plugin data, write back with templates updated,
 * preserving every other top-level key that main.ts owns. We do this
 * field-merge rather than calling plugin.saveData(plugin.settings)
 * because plugin.settings doesn't include templates — they live alongside.
 */
async function readPluginData(plugin: Plugin): Promise<PluginData> {
  const data = (await plugin.loadData()) as PluginData | null;
  return data ?? {};
}

async function writeTemplatesField(
  plugin: Plugin,
  templates: BasicTemplate[],
): Promise<void> {
  const current = await readPluginData(plugin);
  current[TEMPLATES_KEY] = templates;
  await plugin.saveData(current);
}

export function createTemplateStore(plugin: Plugin): TemplateStore {
  // In-memory list. Hydrated lazily on first access via ensureLoaded().
  let templates: BasicTemplate[] | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const l of listeners) l();
  };

  const ensureLoaded = async (): Promise<BasicTemplate[]> => {
    if (templates) return templates;
    const data = await readPluginData(plugin);
    const persisted = data[TEMPLATES_KEY];
    if (Array.isArray(persisted) && persisted.length > 0) {
      templates = persisted;
    } else {
      // First-run: seed and persist so the user can edit/delete freely.
      templates = SEED_TEMPLATES.slice();
      await writeTemplatesField(plugin, templates);
    }
    return templates;
  };

  // Kick off hydration but don't block construction — callers that need
  // a live list before persistence resolves get the seed templates as a
  // fallback.
  void ensureLoaded();

  return {
    getAll(): BasicTemplate[] {
      return templates ?? SEED_TEMPLATES;
    },

    byId(id: string): BasicTemplate | undefined {
      return (templates ?? SEED_TEMPLATES).find((t) => t.id === id);
    },

    expand(t: BasicTemplate, ctx?: ExpandContext): ExpandedTemplate {
      return expandTemplate(t, ctx);
    },

    async upsert(t: BasicTemplate): Promise<void> {
      const list = await ensureLoaded();
      const idx = list.findIndex((x) => x.id === t.id);
      if (idx === -1) list.push(t);
      else list[idx] = t;
      templates = list.slice();
      await writeTemplatesField(plugin, templates);
      notify();
    },

    async remove(id: string): Promise<void> {
      const list = await ensureLoaded();
      const next = list.filter((x) => x.id !== id);
      if (next.length === list.length) return;
      templates = next;
      await writeTemplatesField(plugin, templates);
      notify();
    },

    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

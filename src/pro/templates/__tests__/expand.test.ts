import { describe, it, expect, vi } from 'vitest';
import { expandAdvancedTemplate } from '../expand';
import type { AdvancedTemplate } from '../types';
import { isTemplaterAvailable } from '../templater';

function tpl(overrides: Partial<AdvancedTemplate> = {}): AdvancedTemplate {
  return {
    id: 't1',
    name: 'Test',
    body: '',
    ...overrides,
  };
}

// Build a fake Obsidian App that pretends to host the Templater plugin.
function fakeAppWithTemplater(impl: {
  parse_template?: (cfg: unknown, body: string) => string | Promise<string>;
  parseTemplate?: (cfg: unknown, body: string) => string | Promise<string>;
  throws?: boolean;
}): import('obsidian').App {
  const templater = {
    create_running_config: () => ({}),
    parse_template: impl.throws
      ? () => {
          throw new Error('boom');
        }
      : impl.parse_template,
    parseTemplate: impl.parseTemplate,
  };
  // The shape we cast to matches the structural lookup in templater.ts.
  return {
    plugins: {
      plugins: {
        'templater-obsidian': { templater },
      },
    },
  } as unknown as import('obsidian').App;
}

describe('expandAdvancedTemplate — variable substitution', () => {
  it('substitutes {{date}} and {{time}} from ctx.now', async () => {
    const result = await expandAdvancedTemplate(
      tpl({ body: 'Due {{date}} at {{time}}' }),
      { now: new Date('2026-05-14T09:30:00Z') },
    );
    expect(result.text).toBe('Due 2026-05-14 at 09:30');
  });

  it('substitutes {{var:name}} from template.vars merged with ctx.vars', async () => {
    const result = await expandAdvancedTemplate(
      tpl({ body: 'Hi {{var:name}}, project {{var:proj}}', vars: { name: 'Alex', proj: 'Old' } }),
      { vars: { proj: 'Kanban' } },
    );
    expect(result.text).toBe('Hi Alex, project Kanban');
  });

  it('leaves unresolved {{var:...}} tokens in place', async () => {
    const result = await expandAdvancedTemplate(tpl({ body: 'Hello {{var:unknown}}' }), {});
    expect(result.text).toBe('Hello {{var:unknown}}');
  });

  it('substitutes {{prompt:question}} from userInput', async () => {
    const result = await expandAdvancedTemplate(
      tpl({ body: 'Q: {{prompt:Who?}}' }),
      { userInput: { 'Who?': 'Alice' } },
    );
    expect(result.text).toBe('Q: Alice');
  });

  it('leaves {{prompt:...}} unchanged when no userInput supplied', async () => {
    const result = await expandAdvancedTemplate(tpl({ body: 'Q: {{prompt:Who?}}' }), {});
    expect(result.text).toBe('Q: {{prompt:Who?}}');
  });

  it('returns cursorOffset and strips the {{cursor}} token', async () => {
    const result = await expandAdvancedTemplate(tpl({ body: 'pre{{cursor}}post' }), {});
    expect(result.text).toBe('prepost');
    expect(result.cursorOffset).toBe(3);
  });

  it('omits cursorOffset when no {{cursor}} present', async () => {
    const result = await expandAdvancedTemplate(tpl({ body: 'no cursor here' }), {});
    expect(result.cursorOffset).toBeUndefined();
  });
});

describe('expandAdvancedTemplate — conditional fields', () => {
  it('applies a condition when tags match', async () => {
    const result = await expandAdvancedTemplate(
      tpl({
        body: 'x',
        meta: { tags: ['urgent'] },
        conditions: [
          {
            when: { tagsInclude: ['urgent'] },
            apply: { fields: { priority: 'high' } },
          },
        ],
      }),
      {},
    );
    expect(result.meta?.fields).toEqual({ priority: 'high' });
  });

  it('skips a condition when tags do not match', async () => {
    const result = await expandAdvancedTemplate(
      tpl({
        body: 'x',
        meta: { tags: ['chore'] },
        conditions: [
          {
            when: { tagsInclude: ['urgent'] },
            apply: { fields: { priority: 'high' } },
          },
        ],
      }),
      {},
    );
    expect(result.meta?.fields ?? {}).toEqual({});
  });

  it('later conditions override earlier ones', async () => {
    const result = await expandAdvancedTemplate(
      tpl({
        body: 'x',
        meta: { tags: ['urgent', 'blocker'] },
        conditions: [
          { when: { tagsInclude: ['urgent'] }, apply: { fields: { priority: 'high' } } },
          { when: { tagsInclude: ['blocker'] }, apply: { fields: { priority: 'critical' } } },
        ],
      }),
      {},
    );
    expect(result.meta?.fields?.priority).toBe('critical');
  });

  it('evaluates metaMatches against scalar fields', async () => {
    const result = await expandAdvancedTemplate(
      tpl({
        body: 'x',
        meta: { date: '2026-05-14' },
        conditions: [
          {
            when: { metaMatches: { date: '2026-05-14' } },
            apply: { fields: { schedule: 'today' } },
          },
        ],
      }),
      {},
    );
    expect(result.meta?.fields?.schedule).toBe('today');
  });

  it('merges seed meta into the result base', async () => {
    const result = await expandAdvancedTemplate(
      tpl({ body: 'x', meta: { tags: ['from-template'] } }),
      { seed: { tags: ['from-seed'], fields: { source: 'gh' } } },
    );
    expect(result.meta?.tags?.sort()).toEqual(['from-seed', 'from-template']);
    expect(result.meta?.fields?.source).toBe('gh');
  });
});

describe('expandAdvancedTemplate — Templater bridge', () => {
  it('detects when Templater is installed', () => {
    const app = fakeAppWithTemplater({ parse_template: (_c, b) => b });
    expect(isTemplaterAvailable(app)).toBe(true);
  });

  it('returns false when no app or no plugin', () => {
    expect(isTemplaterAvailable(undefined)).toBe(false);
    expect(isTemplaterAvailable({ } as unknown as import('obsidian').App)).toBe(false);
    expect(isTemplaterAvailable({ plugins: { plugins: {} } } as unknown as import('obsidian').App)).toBe(false);
  });

  it('routes through Templater when useTemplater=true and plugin is present', async () => {
    const parse = vi.fn(async (_cfg, body: string) => body.replace('<%= "x" %>', 'XX'));
    const app = fakeAppWithTemplater({ parse_template: parse });
    const result = await expandAdvancedTemplate(
      tpl({ body: '<%= "x" %> at {{date}}', useTemplater: true }),
      { app, now: new Date('2026-05-14T00:00:00Z') },
    );
    expect(parse).toHaveBeenCalled();
    expect(result.text).toBe('XX at 2026-05-14');
  });

  it('falls back to basic substitution when Templater throws', async () => {
    const app = fakeAppWithTemplater({ throws: true });
    const result = await expandAdvancedTemplate(
      tpl({ body: 'hello {{date}}', useTemplater: true }),
      { app, now: new Date('2026-05-14T00:00:00Z') },
    );
    // Body wasn't transformed by Templater, but substitution still ran.
    expect(result.text).toBe('hello 2026-05-14');
  });

  it('falls back to basic substitution when Templater is not installed', async () => {
    const result = await expandAdvancedTemplate(
      tpl({ body: 'hello {{date}}', useTemplater: true }),
      { now: new Date('2026-05-14T00:00:00Z') },
    );
    expect(result.text).toBe('hello 2026-05-14');
  });
});

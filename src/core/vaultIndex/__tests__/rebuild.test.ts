/**
 * Vault Index tests — focus on the pure summarization (the rebuild loop
 * itself is an orchestration over Obsidian APIs and is exercised in the
 * lifecycle integration tests).
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeBoard,
  parseInlineDate,
  todayLocalMs,
} from '../rebuild';
import type { Board } from '@/core/model';

function makeBoard(): Board {
  return {
    lanes: [
      {
        id: 'lane-1',
        title: 'Todo',
        kind: 'normal',
        collapsed: false,
        cards: [
          {
            id: 'c1',
            text: 'First',
            done: false,
            hash: '',
            subtasks: [],
            meta: {
              tags: ['bug', 'p1'],
              fields: {},
              emoji: {},
              date: yesterday(),
            },
          },
          {
            id: 'c2',
            text: 'Second',
            done: false,
            hash: '',
            subtasks: [],
            meta: {
              tags: ['bug'],
              fields: {},
              emoji: {},
              date: inThreeDays(),
            },
          },
          {
            id: 'c3',
            text: 'Done card with overdue date — should not count as overdue',
            done: true,
            hash: '',
            subtasks: [],
            meta: {
              tags: [],
              fields: {},
              emoji: {},
              date: yesterday(),
            },
          },
        ],
      },
      {
        id: 'lane-2',
        title: 'Done',
        kind: 'complete',
        collapsed: false,
        cards: [],
      },
    ],
    frontmatter: { 'kanban-plugin': 'board', title: 'My Project' },
    settings: {},
    fileTrivia: {
      bom: false,
      newline: '\n',
      trailingNewline: true,
      originalSource: '',
    },
    hash: '',
  };
}

function yyyymmdd(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return yyyymmdd(d);
}

function inThreeDays(): string {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return yyyymmdd(d);
}

describe('parseInlineDate', () => {
  it('parses YYYY-MM-DD', () => {
    const ms = parseInlineDate('2026-01-15');
    expect(Number.isFinite(ms)).toBe(true);
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
  });

  it('returns NaN for malformed input', () => {
    expect(parseInlineDate('garbage')).toBeNaN();
    expect(parseInlineDate('')).toBeNaN();
    expect(parseInlineDate(undefined)).toBeNaN();
  });
});

describe('todayLocalMs', () => {
  it('returns local midnight for the given clock', () => {
    const now = new Date('2026-05-14T15:42:00');
    const ms = todayLocalMs(now);
    const d = new Date(ms);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(14);
  });
});

describe('summarizeBoard', () => {
  it('counts overdue + dueWithin7d + tags + lane totals', () => {
    const board = makeBoard();
    const entry = summarizeBoard(board, 'Folder/Project.md', 1000);
    expect(entry.path).toBe('Folder/Project.md');
    expect(entry.title).toBe('My Project');
    expect(entry.totalCards).toBe(3);
    // c1 yesterday + not-done → overdue. c2 in three days → dueWithin7d.
    // c3 done — neither.
    expect(entry.overdue).toBe(1);
    expect(entry.dueWithin7d).toBe(1);
    expect(entry.laneCounts).toEqual({ Todo: 3, Done: 0 });
    expect(entry.tags).toEqual({ bug: 2, p1: 1 });
    expect(entry.modifiedAt).toBe(1000);
  });

  it('falls back to file basename when frontmatter title missing', () => {
    const board = makeBoard();
    delete (board.frontmatter as Record<string, unknown>)['title'];
    const entry = summarizeBoard(board, 'Folder/Project.md', 1000);
    expect(entry.title).toBe('Project');
  });

  it('counts overdue/dueWithin7d for emoji 📅 dates via meta.emoji.due', () => {
    const board: Board = {
      lanes: [
        {
          id: 'lane-1',
          title: 'Todo',
          kind: 'normal',
          collapsed: false,
          cards: [
            {
              id: 'a',
              text: 'overdue emoji 📅 …',
              done: false,
              hash: '',
              subtasks: [],
              meta: { tags: [], fields: {}, emoji: { due: yesterday() } },
            },
            {
              id: 'b',
              text: 'soon emoji 📅 …',
              done: false,
              hash: '',
              subtasks: [],
              meta: { tags: [], fields: {}, emoji: { due: inThreeDays() } },
            },
          ],
        },
      ],
      frontmatter: {},
      settings: {},
      fileTrivia: { bom: false, newline: '\n', trailingNewline: true, originalSource: '' },
      hash: '',
    };
    const entry = summarizeBoard(board, 'F.md', 1);
    expect(entry.overdue).toBe(1);
    expect(entry.dueWithin7d).toBe(1);
  });
});

#!/usr/bin/env node
/**
 * generateFixture.mjs
 *
 * Emit a 1000-card kanban board fixture at src/__tests__/fixtures/big.md.
 * Used by bench.mjs to drive the cold-open benchmark and by any test that
 * wants a representative-size board.
 *
 * The fixture is byte-for-byte compatible with the incumbent kanban-plugin
 * on-disk format (frontmatter `kanban-plugin: board`, level-2 lane headings,
 * task-list items as cards, `***` + `## Archive`, `%% kanban:settings ... %%`
 * trailing JSON block).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT = resolve(REPO_ROOT, 'src/__tests__/fixtures/big.md');

const LANE_COUNT = 10;
const CARDS_PER_LANE = 100; // 10 * 100 = 1000

const TAGS = ['#bug', '#feature', '#chore', '#docs', '#urgent', '#blocked'];
const ASSIGNEES = ['alice', 'bob', 'carol', 'dave', 'erin'];

function card(laneIdx, cardIdx) {
  const id = `card-${laneIdx}-${cardIdx}`;
  const due = `2026-0${1 + (cardIdx % 9)}-${String(1 + (cardIdx % 28)).padStart(2, '0')}`;
  const tag = TAGS[(laneIdx + cardIdx) % TAGS.length];
  const assignee = ASSIGNEES[cardIdx % ASSIGNEES.length];
  const done = cardIdx % 7 === 0 ? 'x' : ' ';
  // Mix of body lengths and inline metadata to keep the parser honest.
  const body =
    cardIdx % 3 === 0
      ? `Task ${cardIdx} in lane ${laneIdx} @{${due}} ${tag} [assignee:: ${assignee}] ^${id}`
      : `Task ${cardIdx} in lane ${laneIdx} ${tag} [assignee:: ${assignee}]`;
  const sub =
    cardIdx % 5 === 0
      ? `\n  - [ ] subtask a for ${cardIdx}\n  - [x] subtask b for ${cardIdx}`
      : '';
  return `- [${done}] ${body}${sub}`;
}

function lane(idx) {
  const title = idx === LANE_COUNT - 1 ? 'Done\n\n**Complete**' : `Lane ${idx}`;
  const cards = Array.from({ length: CARDS_PER_LANE }, (_, c) => card(idx, c)).join('\n');
  return `## ${title}\n\n${cards}\n`;
}

function build() {
  const frontmatter = ['---', 'kanban-plugin: board', '---', ''].join('\n');
  const lanes = Array.from({ length: LANE_COUNT }, (_, i) => lane(i)).join('\n');
  const archive = `\n***\n\n## Archive\n\n- [x] historical archived card ^archived-0\n`;
  const settings =
    '\n%% kanban:settings\n' +
    JSON.stringify(
      {
        'kanban-plugin': 'board',
        'date-format': 'YYYY-MM-DD',
        'time-format': 'HH:mm',
        'default-view': 'board',
        'lane-width': 272,
      },
      null,
      2,
    ) +
    '\n%%\n';
  return frontmatter + lanes + archive + settings;
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  const md = build();
  await writeFile(OUT, md, 'utf8');
  const cardCount = LANE_COUNT * CARDS_PER_LANE;
  console.log(`generateFixture: wrote ${OUT} (${md.length} bytes, ${cardCount} cards)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

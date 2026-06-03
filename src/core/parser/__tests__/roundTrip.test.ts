/**
 * Round-trip CI gate.
 *
 *   For any board source we produce: serialize(parse(src), src) === src
 *
 * The byte-identity contract is the migration guarantee for the
 * 2.28M existing kanban-plugin users. This file is the gate that
 * holds the line.
 *
 * Strategy:
 *   1. Hand-crafted fixtures — explicit, debuggable, cover every
 *      load-bearing token in the format spec.
 *   2. Trivia variants — for each fixture, run the round-trip with
 *      CRLF, BOM, no-trailing-newline.
 *   3. Property-based — fast-check generators produce small but
 *      diverse boards. The generator outputs source strings only;
 *      the round-trip invariant is checked on the produced string.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as fc from 'fast-check';

import { parseBoard, serializeBoard } from '../index';

const FIXTURE_DIR = join(__dirname, 'fixtures');

function roundTrip(src: string): string {
  const { board, errors } = parseBoard(src);
  expect(board, `parse failed: ${JSON.stringify(errors)}`).not.toBeNull();
  if (!board) throw new Error('unreachable');
  return serializeBoard(board, src);
}

describe('round-trip — hand-crafted fixtures', () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md'));
  expect(files.length).toBeGreaterThanOrEqual(6);

  for (const f of files) {
    const src = readFileSync(join(FIXTURE_DIR, f), 'utf8');

    it(`${f} — LF, no BOM, trailing newline`, () => {
      expect(roundTrip(src)).toBe(src);
    });

    it(`${f} — CRLF`, () => {
      const crlf = src.replace(/\r?\n/g, '\r\n');
      expect(roundTrip(crlf)).toBe(crlf);
    });

    it(`${f} — BOM prefix`, () => {
      const bom = '﻿' + src;
      expect(roundTrip(bom)).toBe(bom);
    });

    it(`${f} — no trailing newline`, () => {
      const noNl = src.replace(/\n+$/, '');
      expect(roundTrip(noNl)).toBe(noNl);
    });
  }
});

/* --------------------------------------------------------------- */
/* Property: invariant must hold for any random small board       */
/* --------------------------------------------------------------- */

const laneTitle = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}$/);
const cardText = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _:.,!?-]{0,60}$/);

const boardSource = fc
  .record({
    fm: fc.constant('---\nkanban-plugin: board\n---\n\n'),
    lanes: fc.array(
      fc.record({
        title: laneTitle,
        cards: fc.array(
          fc.record({ done: fc.boolean(), text: cardText }),
          { minLength: 0, maxLength: 5 },
        ),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    trailingNewline: fc.boolean(),
  })
  .map(({ fm, lanes, trailingNewline }) => {
    const body = lanes
      .map((lane) => {
        const cards = lane.cards
          .map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`)
          .join('\n');
        return `## ${lane.title}\n\n${cards}`;
      })
      .join('\n\n');
    return fm + body + (trailingNewline ? '\n' : '');
  });

describe('round-trip — property', () => {
  it('serialize(parse(src), src) === src for random boards', () => {
    fc.assert(
      fc.property(boardSource, (src) => {
        const result = roundTrip(src);
        return result === src;
      }),
      { numRuns: 200 },
    );
  });
});

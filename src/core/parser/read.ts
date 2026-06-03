/**
 * `parseBoard(source) -> ParseResult`
 *
 * Pipeline:
 *   1.   detect file trivia (BOM, newline style, trailing newline)
 *   2.   run `findSentinels` to locate the load-bearing tokens that
 *        remark may normalise away (archive break, complete marker,
 *        settings block, frontmatter span).
 *   3.   slice off the frontmatter (parsed via `yaml`) and the
 *        settings block (parsed via `parseSettingsJson`).
 *   4.   run unified+remark-parse+remark-gfm on the remaining body
 *        to extract heading and list structure.
 *   5.   walk the mdast to produce Lanes / Cards / Subtasks, while
 *        computing *byte offsets* into the original source for each
 *        node (using a precomputed line offset table).
 *   6.   tokenize each card's text via `parseInlineMeta`.
 *
 * Source positions on every Card/Lane/Subtask are byte offsets into
 * the original source (NOT the body slice). This is the foundation
 * of the byte-identity guarantee for write-back.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import type { Root, Heading, List, ListItem, Paragraph, Text } from 'mdast';

import type {
  Board,
  BoardFrontmatter,
  BoardSettings,
  Card,
  FileTrivia,
  Lane,
  LaneKind,
  ParseError,
  ParseResult,
  SourcePosition,
  Subtask,
} from '@/core/model';
import { hashString } from '@/shared/hash';
import { parseInlineMeta } from './inlineMeta';
import { findSentinels, type SettingsSentinel } from './sentinels';
import { parseSettingsJson } from './settingsBlock';

/* -------------------------------------------------------------- */
/* Public entry                                                   */
/* -------------------------------------------------------------- */

export function parseBoard(source: string): ParseResult {
  const errors: ParseError[] = [];

  const fileTrivia = detectTrivia(source);
  const sentinels = findSentinels(source);

  // 1. frontmatter
  const fmRes = extractFrontmatter(source, sentinels.frontmatter);
  if (fmRes.error) errors.push(fmRes.error);
  const frontmatter = fmRes.frontmatter;
  const fmEnd = sentinels.frontmatter ? sentinels.frontmatter.end : 0;

  // 2. settings (parser-owned)
  let settings: BoardSettings = {};
  if (sentinels.settings) {
    const parsed = parseSettingsJson(sentinels.settings.json, sentinels.settings.jsonStart);
    settings = parsed.settings;
    errors.push(...parsed.errors);
  }

  // 3. body for remark = source minus frontmatter, with settings
  //    block redacted to whitespace (preserves offsets!).
  const bomLen = fileTrivia.bom ? 1 : 0;
  const body = redactRanges(source, [
    [0, Math.max(fmEnd, bomLen)],
    ...(sentinels.settings ? [[sentinels.settings.start, sentinels.settings.end] as [number, number]] : []),
  ]);

  // 4. line-offset table for byte-offset resolution.
  const lineStarts = computeLineStarts(source);

  // 5. parse body via remark; we operate on the redacted body so
  //    remark's line/column numbers continue to match the original
  //    source 1-for-1.
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

  // 6. walk top-level: alternating ## headings and lists.
  const lanes = walkLanes(tree, source, lineStarts, sentinels, errors);

  const board: Board = {
    lanes,
    frontmatter,
    settings,
    fileTrivia,
    hash: hashString(source),
  };

  return { board, errors };
}

/* -------------------------------------------------------------- */
/* File trivia                                                    */
/* -------------------------------------------------------------- */

export function detectTrivia(source: string): FileTrivia {
  const bom = source.charCodeAt(0) === 0xfeff;
  const newline: '\r\n' | '\n' = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = source.endsWith('\n');
  return { bom, newline, trailingNewline, originalSource: source };
}

/* -------------------------------------------------------------- */
/* Frontmatter                                                    */
/* -------------------------------------------------------------- */

interface FrontmatterResult {
  frontmatter: BoardFrontmatter;
  error?: ParseError;
}

function extractFrontmatter(
  source: string,
  fm: ReturnType<typeof findSentinels>['frontmatter'],
): FrontmatterResult {
  if (!fm) return { frontmatter: {} };
  // raw is "---\n...\n---\n" — strip the fences (BOM already excluded
  // from fm.raw by findFrontmatter).
  const inner = fm.raw.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
  try {
    const yaml = parseYaml(inner) as unknown;
    if (yaml === null || yaml === undefined) return { frontmatter: {} };
    if (typeof yaml !== 'object' || Array.isArray(yaml)) {
      return {
        frontmatter: {},
        error: {
          message: 'Frontmatter must be a YAML mapping',
          severity: 'error',
          position: { start: fm.start, end: fm.end },
        },
      };
    }
    return { frontmatter: yaml as BoardFrontmatter };
  } catch (e) {
    return {
      frontmatter: {},
      error: {
        message: `Frontmatter YAML parse failed: ${(e as Error).message}`,
        severity: 'error',
        position: { start: fm.start, end: fm.end },
      },
    };
  }
}

/* -------------------------------------------------------------- */
/* Body redaction                                                 */
/* -------------------------------------------------------------- */

/**
 * Replace each given byte range with spaces (and preserve newlines)
 * so remark's line/column offsets in the *redacted* string equal the
 * line/column offsets in the original source.
 */
export function redactRanges(source: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return source;
  const out = source.split('');
  for (const [s, e] of ranges) {
    for (let i = s; i < e && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  }
  return out.join('');
}

/* -------------------------------------------------------------- */
/* Line-offset table                                              */
/* -------------------------------------------------------------- */

/** Return an array of byte offsets where each line starts (line 1 = index 0). */
export function computeLineStarts(source: string): number[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  return lineStarts;
}

function pointToOffset(lineStarts: number[], line: number, col: number): number {
  // remark uses 1-based lines and columns.
  const ls = lineStarts[line - 1] ?? 0;
  return ls + (col - 1);
}

function nodeRange(
  node: { position?: { start: { line: number; column: number }; end: { line: number; column: number } } },
  lineStarts: number[],
): SourcePosition | undefined {
  if (!node.position) return undefined;
  return {
    start: pointToOffset(lineStarts, node.position.start.line, node.position.start.column),
    end: pointToOffset(lineStarts, node.position.end.line, node.position.end.column),
  };
}

/* -------------------------------------------------------------- */
/* Lane / Card walker                                             */
/* -------------------------------------------------------------- */

interface WalkCtx {
  source: string;
  lineStarts: number[];
  sentinels: ReturnType<typeof findSentinels>;
  errors: ParseError[];
  cardCounter: { n: number };
  laneCounter: { n: number };
  subtaskCounter: { n: number };
}

function walkLanes(
  tree: Root,
  source: string,
  lineStarts: number[],
  sentinels: ReturnType<typeof findSentinels>,
  errors: ParseError[],
): Lane[] {
  const ctx: WalkCtx = {
    source,
    lineStarts,
    sentinels,
    errors,
    cardCounter: { n: 0 },
    laneCounter: { n: 0 },
    subtaskCounter: { n: 0 },
  };

  const lanes: Lane[] = [];
  let inArchive = false;

  // Iterate top-level children only; lanes are level-2 headings.
  const children = tree.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];

    // Track when we enter the archive section.
    if (node.type === 'thematicBreak' && sentinels.archiveBreak) {
      const r = nodeRange(node, lineStarts);
      if (r && r.start === sentinels.archiveBreak.start) inArchive = true;
      continue;
    }

    if (node.type !== 'heading') continue;
    const heading = node as Heading;
    if (heading.depth !== 2) continue;

    const title = headingText(heading);
    const titleTrim = title.trim();

    // Determine kind: archive or normal. `complete` is detected by
    // looking for a **Complete** marker inside the lane's content.
    let kind: LaneKind = 'normal';
    if (inArchive || /^Archive$/i.test(titleTrim)) {
      kind = 'archive';
      inArchive = true;
    }

    // Find the lane content range: from the heading to the next
    // depth-2 heading or thematic break or end-of-body.
    const headingPos = nodeRange(heading, lineStarts);
    if (!headingPos) continue;
    let endIdx = children.length;
    for (let j = i + 1; j < children.length; j++) {
      const n = children[j];
      if (n.type === 'heading' && (n as Heading).depth === 2) {
        endIdx = j;
        break;
      }
      if (n.type === 'thematicBreak' && sentinels.archiveBreak) {
        const r = nodeRange(n, lineStarts);
        if (r && r.start === sentinels.archiveBreak.start) {
          endIdx = j;
          break;
        }
      }
    }

    const lastChild = children[endIdx - 1];
    const lastChildPos = nodeRange(lastChild as any, lineStarts);
    const laneEnd = lastChildPos?.end ?? headingPos.end;

    // Walk lane content for **Complete** marker and the card list.
    const cards: Card[] = [];
    let collapsed = false;
    for (let j = i + 1; j < endIdx; j++) {
      const child = children[j];

      // **Complete** lane marker: a paragraph whose single child is a
      // single strong-node containing the literal text "Complete".
      if (child.type === 'paragraph' && isCompleteMarkerParagraph(child as Paragraph)) {
        if (kind !== 'archive') kind = 'complete';
        continue;
      }

      if (child.type === 'list') {
        const list = child as List;
        for (const item of list.children) {
          if (item.type !== 'listItem') continue;
          const card = listItemToCard(item as ListItem, ctx);
          if (card) cards.push(card);
        }
      }
    }

    lanes.push({
      id: nextId('L', ctx.laneCounter),
      title: titleTrim,
      kind,
      cards,
      collapsed,
      position: { start: headingPos.start, end: laneEnd },
    });
  }

  return lanes;
}

function headingText(heading: Heading): string {
  let out = '';
  visit(heading, 'text', (node: Text) => {
    out += node.value;
  });
  return out;
}

function isCompleteMarkerParagraph(p: Paragraph): boolean {
  if (p.children.length !== 1) return false;
  const c = p.children[0];
  if (c.type !== 'strong') return false;
  const inner = (c.children[0] as Text | undefined)?.value?.trim();
  return inner === 'Complete';
}

/* -------------------------------------------------------------- */
/* List-item -> Card / Subtask                                    */
/* -------------------------------------------------------------- */

function listItemToCard(item: ListItem, ctx: WalkCtx): Card | null {
  if (item.checked === null || item.checked === undefined) {
    // Not a task-list item; skip. Real cards always have [ ] or [x].
    return null;
  }
  const pos = nodeRange(item, ctx.lineStarts);
  if (!pos) return null;

  // The card "text" is the first paragraph's text, joined.
  let text = '';
  const subtasks: Subtask[] = [];
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      if (!text) {
        text = paragraphText(child as Paragraph);
      } else {
        // multi-paragraph card: join with newlines, preserves
        // semantic content for hashing/inline-meta even though the
        // writer will re-emit from byte slice when unchanged.
        text += '\n' + paragraphText(child as Paragraph);
      }
    } else if (child.type === 'list') {
      // nested list = subtasks
      for (const sub of (child as List).children) {
        if (sub.type !== 'listItem') continue;
        const st = listItemToSubtask(sub as ListItem, ctx);
        if (st) subtasks.push(st);
      }
    }
  }

  const meta = parseInlineMeta(text).meta;
  const raw = ctx.source.slice(pos.start, pos.end);
  return {
    id: nextId('C', ctx.cardCounter),
    text,
    done: item.checked === true,
    position: pos,
    hash: hashString(raw),
    meta,
    subtasks,
  };
}

function listItemToSubtask(item: ListItem, ctx: WalkCtx): Subtask | null {
  const pos = nodeRange(item, ctx.lineStarts);
  const text = item.children
    .filter((c) => c.type === 'paragraph')
    .map((c) => paragraphText(c as Paragraph))
    .join(' ');
  return {
    id: nextId('S', ctx.subtaskCounter),
    text,
    done: item.checked === true,
    position: pos,
  };
}

function paragraphText(p: Paragraph): string {
  // Reconstruct by node value. This is *display* text — the writer
  // will use the byte slice for hash-stable cards.
  let out = '';
  visit(p, (n) => {
    const nn = n as { type: string; value?: string };
    if (nn.value !== undefined) out += nn.value;
  });
  return out;
}

/* -------------------------------------------------------------- */
/* Util                                                            */
/* -------------------------------------------------------------- */

function nextId(prefix: string, counter: { n: number }): string {
  counter.n += 1;
  return `${prefix}-${counter.n}`;
}

// Re-export for tests / writer.
export { findSentinels };
export type { SettingsSentinel };

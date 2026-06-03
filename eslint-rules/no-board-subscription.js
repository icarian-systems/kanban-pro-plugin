/**
 * @fileoverview ESLint rule: forbid subscribing to the whole `state.board`
 * inside the UI / View layers.
 *
 * The Kanban Pro selector contract (see src/core/store.ts) states that
 * components MUST NOT subscribe to `state.board` or any board-scope object
 * reference. Every mutation produces a new Board object (Immer), so a
 * subscription to the board ref would re-render every subscriber on every
 * keystroke — that's the incumbent plugin's primary failure mode.
 *
 * This rule flags:
 *
 *   1. `useStoreSelector(s => s.board)` and `useStoreSelector(state => state.board)`
 *   2. `useStore(s => s.board)`
 *   3. `store(s => s.board)`               (calling the Zustand store as a hook)
 *   4. Property reads `state.board` / `s.board` inside selectors and effects
 *
 * The rule applies inside `src/ui/**` and `src/view/**`. The store itself
 * lives in `src/core/store.ts` and is exempt — it's the canonical owner
 * of the board reference and *must* read it.
 */
'use strict';

const BOARD_PROPS = new Set(['board']);

/**
 * Returns true if `node.body` (an expression body of an arrow function)
 * reads `.board` from the function's single parameter.
 */
function arrowReadsBoardFromParam(arrow) {
  if (!arrow.params || arrow.params.length === 0) return null;
  const param = arrow.params[0];
  if (param.type !== 'Identifier') return null;
  const paramName = param.name;

  const body = arrow.body;
  // Expression body: `s => s.board`
  if (body.type === 'MemberExpression') {
    if (
      body.object.type === 'Identifier' &&
      body.object.name === paramName &&
      body.property.type === 'Identifier' &&
      BOARD_PROPS.has(body.property.name)
    ) {
      return body;
    }
  }
  // Block body: `s => { return s.board }` — best-effort check on the first
  // return statement.
  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) {
      if (stmt.type === 'ReturnStatement' && stmt.argument) {
        const ret = stmt.argument;
        if (
          ret.type === 'MemberExpression' &&
          ret.object.type === 'Identifier' &&
          ret.object.name === paramName &&
          ret.property.type === 'Identifier' &&
          BOARD_PROPS.has(ret.property.name)
        ) {
          return ret;
        }
      }
    }
  }
  return null;
}

const SELECTOR_HOOK_NAMES = new Set([
  'useStoreSelector',
  'useStore',
  'useBoardStore',
]);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid subscriptions to the whole `state.board` object — re-renders every component on every mutation.',
    },
    schema: [],
    messages: {
      noBoardSubscription:
        'Do not subscribe to `state.board`. Subscribe to a stable ref or ID array instead — see src/core/store.ts selector helpers.',
    },
  },

  create(context) {
    return {
      // Pattern 1+2+3: useStore(s => s.board) / useStoreSelector(...) / store(...)
      CallExpression(node) {
        // Determine whether the callee is one of the selector hooks OR a
        // bare identifier that's plausibly a Zustand store hook. We err
        // on the side of catching `boardStore(s => s.board)` patterns by
        // accepting any single-arg call whose first arg is a simple arrow.
        let isSelectorHook = false;
        if (node.callee.type === 'Identifier') {
          if (SELECTOR_HOOK_NAMES.has(node.callee.name)) {
            isSelectorHook = true;
          } else if (
            node.arguments.length === 1 &&
            node.arguments[0].type === 'ArrowFunctionExpression'
          ) {
            // Bare-identifier callee with an arrow selector — assume it's
            // a Zustand store invocation (the Frontend convention is
            // `store(s => …)`).
            isSelectorHook = true;
          }
        }
        if (!isSelectorHook) return;

        const firstArg = node.arguments[0];
        if (
          !firstArg ||
          (firstArg.type !== 'ArrowFunctionExpression' &&
            firstArg.type !== 'FunctionExpression')
        ) {
          return;
        }
        const offending = arrowReadsBoardFromParam(firstArg);
        if (offending) {
          context.report({ node: offending, messageId: 'noBoardSubscription' });
        }
      },

      // Pattern 4: `state.board` / `s.board` direct member reads. We are
      // intentionally conservative — we only flag reads whose object is
      // the literal identifier `state` or a name that begins with
      // `state` (e.g. `boardState`). Plain `s.board` would over-fire
      // outside selectors, so we skip it for the property-read path.
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          /^state/i.test(node.object.name) &&
          node.property.type === 'Identifier' &&
          BOARD_PROPS.has(node.property.name)
        ) {
          context.report({ node, messageId: 'noBoardSubscription' });
        }
      },
    };
  },
};

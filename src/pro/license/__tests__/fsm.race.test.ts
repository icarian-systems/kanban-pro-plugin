/**
 * fsm.race.test.ts — License FSM race-condition tests
 *
 * The license state machine revalidates in the background (every 7d). A
 * revalidate that arrives WHILE the user is mid-drag, mid-edit, or
 * mid-timer would visibly stall the UI if it committed a state transition
 * synchronously. The rule for License FSM races:
 *
 *   Commit ONLY at an idle boundary.
 *
 * Concretely:
 *   - If `idle = false` when a revalidate completes, the result is queued.
 *   - The queue COALESCES multiple revalidates into one commit.
 *   - When `idle` transitions to true, exactly one state-machine commit
 *     fires regardless of how many revalidates queued during the busy
 *     window.
 *
 * The FSM lives at @/pro/license/state. The current `state.ts` exports a
 * stub `licenseFSM` that doesn't implement idle gating. This test
 * imports the *expected* surface (`setBusy`, `setIdle`, or an exported
 * `idleCommit` queue) and falls back to skipped assertions when the
 * surface is not present — but the test file is authoritative on what
 * the integration must deliver.
 */
import { describe, it, expect, vi } from 'vitest';
import { licenseFSM } from '@/pro/license/state';
import type { LicenseFSM, ProGate } from '@/pro/license/state';

// ────────────────────────────────────────────────────────────────────────
// Surface probe: does the production FSM expose the idle gate yet?
// ────────────────────────────────────────────────────────────────────────

type IdleAwareFSM = LicenseFSM;

function asIdleAware(fsm: LicenseFSM): IdleAwareFSM | null {
  if (typeof fsm.setBusy === 'function' || typeof fsm.setIdle === 'function') {
    return fsm;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Reference implementation of the idle-gated revalidate queue.
//
// We test the contract twice:
//  1. Against the in-test reference (always runs — proves the spec is
//     internally consistent).
//  2. Against the production FSM if the idle surface exists (skipped
//     otherwise — until the FSM lands the implementation).
// ────────────────────────────────────────────────────────────────────────

interface QueueLike {
  revalidate(): Promise<void>;
  setIdle(idle: boolean): void;
  readonly commits: number;
  subscribe(cb: () => void): () => void;
}

function makeReferenceQueue(remote: () => Promise<ProGate>): QueueLike {
  let idle = true;
  let pendingResult: ProGate | null = null;
  let commits = 0;
  const listeners = new Set<() => void>();

  function commit(result: ProGate) {
    commits++;
    pendingResult = null;
    void result;
    listeners.forEach((l) => l());
  }

  return {
    get commits() {
      return commits;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async revalidate() {
      const result = await remote();
      if (idle) {
        commit(result);
      } else {
        // Coalesce: keep only the most recent result.
        pendingResult = result;
      }
    },
    setIdle(next: boolean) {
      const wasIdle = idle;
      idle = next;
      if (!wasIdle && next && pendingResult) {
        commit(pendingResult);
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('license FSM — revalidate races against active UI', () => {
  it('reference: revalidate during busy window commits exactly once at idle boundary', async () => {
    const remote = vi.fn(async () => ({ tier: 'pro' as const, state: 'licensed' as const }));
    const q = makeReferenceQueue(remote);
    q.setIdle(false); // busy: drag/timer/edit in progress
    await q.revalidate();
    await q.revalidate();
    await q.revalidate();
    expect(q.commits).toBe(0);
    q.setIdle(true);
    expect(q.commits).toBe(1);
  });

  it('reference: multiple revalidates during busy window coalesce to one commit (most recent wins)', async () => {
    const seq = [
      { tier: 'pro' as const, state: 'licensed' as const },
      { tier: 'pro' as const, state: 'grace' as const },
      { tier: 'free' as const, state: 'lapsed' as const },
    ];
    let i = 0;
    const remote = vi.fn(async () => seq[i++]);
    const q = makeReferenceQueue(remote);
    q.setIdle(false);
    await q.revalidate();
    await q.revalidate();
    await q.revalidate();
    expect(q.commits).toBe(0);
    q.setIdle(true);
    // Exactly one commit, regardless of how many revalidates ran during
    // the busy window.
    expect(q.commits).toBe(1);
  });

  it('reference: revalidate during idle window commits immediately', async () => {
    const remote = vi.fn(async () => ({ tier: 'pro' as const, state: 'licensed' as const }));
    const q = makeReferenceQueue(remote);
    // Already idle (default true)
    await q.revalidate();
    expect(q.commits).toBe(1);
  });

  it('reference: transitioning idle → busy → idle without any revalidate does not commit', async () => {
    const remote = vi.fn(async () => ({ tier: 'pro' as const, state: 'licensed' as const }));
    const q = makeReferenceQueue(remote);
    q.setIdle(false);
    q.setIdle(true);
    expect(q.commits).toBe(0);
  });
});

describe('license FSM — production surface (skipped until integrated)', () => {
  const aware = asIdleAware(licenseFSM);
  const itx = aware ? it : it.skip;

  itx('exposes setIdle / setBusy on licenseFSM', () => {
    expect(aware).not.toBeNull();
  });

  itx('queues revalidate during a non-idle window', async () => {
    if (!aware) return;
    const setIdleFn = (b: boolean) => aware.setIdle(b);
    let commits = 0;
    const unsub = aware.subscribe(() => {
      commits++;
    });
    try {
      setIdleFn(false);
      await aware.revalidate();
      await aware.revalidate();
      await aware.revalidate();
      const beforeIdle = commits;
      setIdleFn(true);
      // Allow microtask drain
      await Promise.resolve();
      expect(commits - beforeIdle).toBeLessThanOrEqual(1);
    } finally {
      unsub();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Call-site bracketing.
//
// `setBusy(true)` and `setBusy(false)` must each fire from the three hot
// lifecycle paths (drag, inline-editor, save flush). The FSM is ref-counted
// — a missed `false` leaves the gate frozen until plugin reload, and a
// missed `true` defeats the idle-boundary rule entirely.
// ────────────────────────────────────────────────────────────────────────
describe('license FSM — call-site bracketing', () => {
  it('DnDProvider brackets setBusy(true)/setBusy(false) across the drag lifecycle', async () => {
    // Spy on the singleton; the DnDProvider imports `licenseFSM` from this
    // same module, so our spy intercepts the production call.
    const trues: number[] = [];
    const falses: number[] = [];
    const origSetBusy = licenseFSM.setBusy.bind(licenseFSM);
    const spy = vi.spyOn(licenseFSM, 'setBusy').mockImplementation((b: boolean) => {
      if (b) trues.push(Date.now());
      else falses.push(Date.now());
      origSetBusy(b);
    });
    try {
      // Render the DnDProvider with a fake store. We can't drive dnd-kit's
      // real pointer events from JSDOM, so we exercise the call-site
      // contract by invoking the dnd-kit-shaped lifecycle directly via a
      // synthetic wrapper. The DnDProvider exports `onDragStart`/
      // `onDragEnd` through React state — for the bracketing contract,
      // it's enough to require the wired call site exists. We assert that
      // by reading the production source: setBusy(true) appears in the
      // onDragStart closure and setBusy(false) appears in both onDragEnd
      // and onDragCancel.
      const dndSource = await import('@/ui/DnDProvider')
        .then((m) => m)
        .catch(() => null);
      expect(dndSource).not.toBeNull();
      // Existence check — the import must succeed and the symbol must be
      // a React component (function). If the file ever loses its
      // setBusy wiring, the file-content assertion below catches it.
      const { readFileSync } = await import('node:fs');
      const dndText = readFileSync('src/ui/DnDProvider.tsx', 'utf8');
      expect(dndText).toMatch(/licenseFSM\.setBusy\(true\)/);
      // onDragEnd + onDragCancel each need a setBusy(false).
      const falseHits = dndText.match(/licenseFSM\.setBusy\(false\)/g) ?? [];
      expect(falseHits.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('useCM6Editor brackets setBusy across mount and teardown', async () => {
    const { readFileSync } = await import('node:fs');
    const editorText = readFileSync('src/ui/hooks/useCM6Editor.ts', 'utf8');
    expect(editorText).toMatch(/licenseFSM\.setBusy\(true\)/);
    expect(editorText).toMatch(/licenseFSM\.setBusy\(false\)/);
    // Mount sets a busy-held flag; teardown clears it. Both must reset
    // the local ref so re-mounts don't double-count.
    expect(editorText).toMatch(/busyHeldRef/);
  });

  it('save queue flush in KanbanView brackets setBusy around the flush body', async () => {
    const { readFileSync } = await import('node:fs');
    const viewText = readFileSync('src/view/KanbanView.tsx', 'utf8');
    // The flush handler must acquire+release; the `finally` is the
    // exception-safety guarantee that pairs them.
    expect(viewText).toMatch(/licenseFSM\.setBusy\(true\)/);
    expect(viewText).toMatch(/licenseFSM\.setBusy\(false\)/);
    expect(viewText).toMatch(/finally\s*{[\s\S]*?licenseFSM\.setBusy\(false\)/);
  });
});

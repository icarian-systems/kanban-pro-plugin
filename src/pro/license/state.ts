/**
 * License finite state machine.
 *
 * States:
 *   Unlicensed → Activating → Licensed → Revalidating → Licensed
 *                                     ↘ Grace → Licensed (came back online)
 *                                     ↘ Grace → Lapsed (30d offline + token expired)
 *                                     ↘ Lapsed → Unlicensed (data preserved, writes blocked)
 *
 * Idle-boundary rule:
 *   Transitions out of Revalidating / Grace must NOT mutate user-facing
 *   state while the user is mid-interaction. We compute the desired state
 *   continuously, but only commit when `idle === true` (no active drag, no
 *   open inline editor, no in-flight save, no running timer).
 *
 *   The store of "idle-ness" is owned externally — the KanbanView toggles
 *   `setBusy(true)` on drag-start / editor-open / save-flight, and `setBusy(false)`
 *   on drag-end / editor-blur / save-settle. The FSM coalesces queued
 *   transitions into one commit when idle goes from false → true.
 */

import { useSyncExternalStore } from 'react';
import type { LicenseState, LicenseTier, ProGate } from '@/core/model';
import { verifyToken, type TokenPayload, type VerifyResult } from './verify';
import { activate as remoteActivate, validate as remoteValidate, fetchRevocations } from './remote';
import { log } from '@/shared/log';

export type { LicenseState, LicenseTier, ProGate };

/** 30 days of offline grace, per architecture. */
const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface ActivationParams {
  email: string;
  key: string;
}

export interface PersistedLicense {
  token: string;
  exp: number;
  /** Last time we successfully reached the server, ms epoch. */
  lastValidatedAt: number;
  /** When the offline grace clock started (or 0 if not in grace). */
  graceStartedAt: number;
  /** Last-known subject — used to detect revocations. */
  sub: string;
  entitlements?: string[];
}

export interface LicensePersistence {
  load: () => Promise<PersistedLicense | null>;
  save: (p: PersistedLicense | null) => Promise<void>;
}

export interface LicenseFSM {
  getGate: () => ProGate;
  getEntitlements: () => string[];
  hasEntitlement: (k: string) => boolean;

  /** Activate online — exchanges a Lemon Squeezy key for a signed token. */
  activate: (params: ActivationParams | string) => Promise<ProGate>;
  /** Force a revalidate check against the server. Queues if not idle. */
  revalidate: () => Promise<ProGate>;
  /** Drop the license locally; preserves data, blocks Pro writes. */
  deactivate: () => Promise<void>;

  /**
   * Pull the incremental revocation feed and demote the FSM to
   * unlicensed if the currently-licensed token's `sub` is on the
   * returned list. Returns the new cursor for the caller (main.ts)
   * to persist via plugin settings. The FSM itself stays
   * persistence-agnostic.
   */
  pollRevocations: (since: number) => Promise<{ revoked: string[]; cursor: number }>;

  /** Tell the FSM the host is busy (drag/edit/save/timer). Transitions queue. */
  setBusy: (busy: boolean) => void;
  /** Convenience inverse of setBusy. */
  setIdle: (idle: boolean) => void;

  /** Subscribe to gate changes. Returns an unsubscribe function. */
  subscribe: (cb: () => void) => () => void;
}

interface PendingTransition {
  next: ProGate;
  persist?: PersistedLicense | null;
}

/**
 * The v1.0 Pro tier is a single SKU — there are no per-feature purchases — so
 * any Pro license in good standing unlocks every v1 Pro feature, regardless
 * of which entitlement strings the server happens to enumerate in the token
 * (historically only `recurrence` + `savedViews`). Gating each feature on its
 * own key kept the door open for future add-on SKUs, but at launch a paying
 * user must never see a locked feature just because the token under-listed
 * it. Keys NOT in this set still require explicit enumeration in the token.
 */
export const V1_PRO_ENTITLEMENTS: readonly string[] = [
  'recurrence',
  'savedViews',
  'tracking',
  'calendar',
  'dashboard',
];

class LicenseFSMImpl implements LicenseFSM {
  private gate: ProGate = { tier: 'free', state: 'unlicensed' };
  private payload: TokenPayload | null = null;
  private persisted: PersistedLicense | null = null;
  private listeners = new Set<() => void>();
  /**
   * Ref-count of independent busy sources (drag, editor, save flight).
   * `busy` is `busyCount > 0`. Multiple callers can hold the busy flag
   * simultaneously — the FSM only commits queued transitions when every
   * caller has released. This keeps each call site (DnDProvider, editor,
   * save queue) ignorant of the others; they each pair their own
   * setBusy(true)/setBusy(false).
   */
  private busyCount = 0;
  private pending: PendingTransition | null = null;
  private persistence: LicensePersistence | null = null;
  private now: () => number = () => Date.now();

  /** Wire host-side persistence (typically plugin.loadData / saveData). */
  attachPersistence(p: LicensePersistence): void {
    this.persistence = p;
  }

  /** Override the clock — used by tests. */
  setClock(now: () => number): void {
    this.now = now;
  }

  getGate(): ProGate {
    return this.gate;
  }

  getEntitlements(): string[] {
    return this.persisted?.entitlements ?? this.payload?.entitlements ?? [];
  }

  hasEntitlement(k: string): boolean {
    if (this.gate.tier !== 'pro') return false;
    if (this.gate.state === 'lapsed' || this.gate.state === 'unlicensed') return false;
    // Single Pro tier: every v1 feature is unlocked for a Pro license in good
    // standing, even if the token under-enumerated it. See V1_PRO_ENTITLEMENTS.
    if (V1_PRO_ENTITLEMENTS.includes(k)) return true;
    return this.getEntitlements().includes(k);
  }

  async load(): Promise<void> {
    if (!this.persistence) return;
    const p = await this.persistence.load();
    if (!p) return;
    this.persisted = p;
    const result = await verifyToken(p.token);
    this.applyVerify(result, p);
  }

  async activate(params: ActivationParams | string): Promise<ProGate> {
    try {
      const args = typeof params === 'string'
        ? parseActivationString(params)
        : params;
      const resp = await remoteActivate(args.email, args.key);
      const verify = await verifyToken(resp.token);
      if (!verify.ok) {
        // Server signed but the verifier rejected — wrong kid, expired
        // on arrival, or tampered. Surface the reason rather than the
        // generic "activation failed" silence.
        const message = `License token rejected by client verifier: ${verify.reason ?? 'unknown reason'}`;
        log.error('license activate: verifier rejected server-signed token', verify);
        this.commit({
          next: {
            tier: 'free',
            state: 'unlicensed',
            lastError: { message, at: this.now() },
          },
          persist: null,
        });
        return this.gate;
      }
      const persisted: PersistedLicense = {
        token: resp.token,
        exp: resp.exp,
        lastValidatedAt: this.now(),
        graceStartedAt: 0,
        sub: verify.payload.sub,
        entitlements: verify.payload.entitlements,
      };
      this.payload = verify.payload;
      this.persisted = persisted;
      // Clear any prior lastError on success.
      this.commit({
        next: { tier: 'pro', state: 'licensed' },
        persist: persisted,
      });
      return this.gate;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('license activate failed', err);
      this.commit({
        next: {
          tier: 'free',
          state: 'unlicensed',
          lastError: { message, at: this.now() },
        },
        persist: null,
      });
      return this.gate;
    }
  }

  async revalidate(): Promise<ProGate> {
    if (!this.persisted) return this.gate;
    try {
      const resp = await remoteValidate(this.persisted.token);
      const now = this.now();
      if (resp.status === 'revoked' || resp.status === 'refunded') {
        this.payload = null;
        this.commit({
          next: { tier: 'free', state: 'lapsed' },
          persist: { ...this.persisted, lastValidatedAt: now },
        });
        return this.gate;
      }
      if (resp.status === 'rotated' && resp.token) {
        const v = await verifyToken(resp.token);
        if (v.ok) {
          this.payload = v.payload;
          this.persisted = {
            ...this.persisted,
            token: resp.token,
            exp: v.payload.exp,
            lastValidatedAt: now,
            graceStartedAt: 0,
            entitlements: v.payload.entitlements ?? this.persisted.entitlements,
          };
          this.commit({
            next: { tier: 'pro', state: 'licensed' },
            persist: this.persisted,
          });
          return this.gate;
        }
        // Rotated response BUT the verifier rejected the new token — the
        // server signed with a `kid` we don't ship, the new token's `exp`
        // is in the past, or it was tampered with in transit. We MUST
        // NOT silently fall through and treat the response as a plain
        // `status: 'ok'` (the old code did exactly that, which left the
        // user pinned to an old token whose lifetime the server has
        // already abandoned). Surface as a hard failure: drop to lapsed
        // and clear the persisted record so the next online cycle
        // forces a fresh activation.
        log.error(
          'license revalidate: rotated token rejected by client verifier — demoting to lapsed',
          v,
        );
        this.payload = null;
        const lastError = {
          message: `Rotated license token rejected by client verifier: ${v.reason ?? 'unknown reason'}`,
          at: now,
        };
        this.commit({
          next: { tier: 'free', state: 'lapsed', lastError },
          persist: null,
        });
        return this.gate;
      }
      // status: 'ok' — clear grace, refresh validation timestamp.
      this.persisted = { ...this.persisted, lastValidatedAt: now, graceStartedAt: 0 };
      this.commit({
        next: { tier: 'pro', state: 'licensed' },
        persist: this.persisted,
      });
      return this.gate;
    } catch {
      // Network or server error — enter grace if we weren't already.
      this.enterGrace();
      return this.gate;
    }
  }

  async deactivate(): Promise<void> {
    this.payload = null;
    this.persisted = null;
    this.commit({
      next: { tier: 'free', state: 'unlicensed' },
      persist: null,
    });
  }

  /**
   * Poll the revocations feed and demote the FSM if the currently-
   * licensed token's `sub` appears on the returned list.
   *
   * Persistence-agnostic: the caller (main.ts) is responsible for
   * persisting the returned cursor through plugin settings. We don't
   * call loadData/saveData here — keeping that boundary clean means the
   * FSM stays testable without an Obsidian Plugin instance.
   *
   * Errors are swallowed and logged — a transient revocations fetch
   * failure shouldn't crash the 24h timer that drives it. The next
   * poll will retry with the same cursor.
   */
  async pollRevocations(since: number): Promise<{ revoked: string[]; cursor: number }> {
    try {
      const resp = await fetchRevocations(since);
      if (this.persisted) {
        for (const sub of resp.revoked) {
          if (sub === this.persisted.sub) {
            log.warn('license revoked by server — demoting FSM to unlicensed', { sub });
            this.payload = null;
            // Clear the persisted token so a reboot doesn't restore the
            // revoked license. Data is preserved at the view layer.
            this.persisted = null;
            this.commit({
              next: { tier: 'free', state: 'unlicensed' },
              persist: null,
            });
            break;
          }
        }
      }
      return { revoked: resp.revoked, cursor: resp.cursor };
    } catch (err) {
      log.warn('pollRevocations failed', err);
      // Return the caller's cursor unchanged so they don't advance past
      // a window we never successfully fetched.
      return { revoked: [], cursor: since };
    }
  }

  setBusy(busy: boolean): void {
    if (busy) {
      this.busyCount += 1;
      return;
    }
    if (this.busyCount === 0) return;
    this.busyCount -= 1;
    if (this.busyCount === 0 && this.pending) {
      const p = this.pending;
      this.pending = null;
      this.applyCommit(p);
    }
  }

  setIdle(idle: boolean): void {
    this.setBusy(!idle);
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ── internal ─────────────────────────────────────────────────────────

  private commit(t: PendingTransition): void {
    if (this.busyCount > 0) {
      // Coalesce — most recent transition wins.
      this.pending = t;
      return;
    }
    this.applyCommit(t);
  }

  private applyCommit(t: PendingTransition): void {
    const changed =
      t.next.tier !== this.gate.tier || t.next.state !== this.gate.state;
    this.gate = t.next;
    if (this.persistence && t.persist !== undefined) {
      // Fire-and-forget; we don't block UI on persistence write.
      this.persistence.save(t.persist).catch(() => { /* swallow */ });
    }
    if (changed) {
      for (const l of this.listeners) l();
    } else {
      // Even if state didn't change, notify so subscribers can re-read
      // entitlements after a rotated-but-equivalent token.
      for (const l of this.listeners) l();
    }
  }

  private enterGrace(): void {
    if (!this.persisted) return;
    // The grace clock anchors the 30-day offline tolerance window. It
    // MUST be stamped on the first transition into grace and frozen
    // thereafter — every restart that finds `graceStartedAt === 0`
    // (the not-yet-in-grace sentinel) used to overwrite it with
    // `this.now()`, silently resetting the 30-day window on every cold
    // start. A user could lose network connectivity for years and the
    // grace clock would keep ticking from "now" each launch.
    //
    // Fix: only stamp `now()` when the persisted value is the not-in-
    // grace sentinel (0); otherwise honour the existing anchor verbatim
    // so the elapsed-time math sees true offline duration.
    const wasInGrace = this.persisted.graceStartedAt > 0;
    const graceStartedAt = wasInGrace ? this.persisted.graceStartedAt : this.now();
    const elapsed = this.now() - graceStartedAt;
    const expExpired = this.persisted.exp * 1000 < this.now();
    if (elapsed > GRACE_PERIOD_MS && expExpired) {
      this.payload = null;
      this.commit({
        next: { tier: 'free', state: 'lapsed' },
        persist: { ...this.persisted, graceStartedAt },
      });
      return;
    }
    this.persisted = { ...this.persisted, graceStartedAt };
    this.commit({
      next: { tier: 'pro', state: 'grace' },
      persist: this.persisted,
    });
  }

  private applyVerify(result: VerifyResult, p: PersistedLicense): void {
    if (result.ok) {
      this.payload = result.payload;
      this.commit({
        next: { tier: 'pro', state: 'licensed' },
      });
      return;
    }
    if (result.reason === 'expired') {
      // Token expired but we may still be in grace.
      this.enterGrace();
      return;
    }
    // Tampered, malformed, wrong kid — hard invalidate.
    this.payload = null;
    this.persisted = null;
    this.commit({
      next: { tier: 'free', state: 'unlicensed' },
      persist: null,
    });
  }
}

function parseActivationString(s: string): ActivationParams {
  // Accept either "email|key" or a JSON blob {email, key}. Forgiving by design.
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    return { email: String(j.email ?? ''), key: String(j.key ?? '') };
  }
  const pipe = trimmed.indexOf('|');
  if (pipe > 0) {
    return { email: trimmed.slice(0, pipe), key: trimmed.slice(pipe + 1) };
  }
  // No email separator — treat the whole string as the key.
  return { email: '', key: trimmed };
}

// Singleton — one FSM per plugin instance, attached by main.ts.
export const licenseFSM = new LicenseFSMImpl();

// Expose the concrete class for tests and the plugin's persistence wiring.
export type { LicenseFSMImpl };
export { LicenseFSMImpl as LicenseFSMClass };

/**
 * React hook returning the current ProGate. All Pro feature gating goes
 * through this hook — if `gate.tier === 'free'`, render a paywall instead.
 */
export function useProGate(): ProGate {
  return useSyncExternalStore(
    (cb) => licenseFSM.subscribe(cb),
    () => licenseFSM.getGate(),
    () => licenseFSM.getGate(),
  );
}

/** Standalone hook for entitlement checks (e.g. `useEntitlement('recurrence')`). */
export function useEntitlement(key: string): boolean {
  // Subscribe to gate changes; re-evaluate entitlements on every change.
  useSyncExternalStore(
    (cb) => licenseFSM.subscribe(cb),
    () => licenseFSM.getGate().state + '|' + licenseFSM.getEntitlements().join(','),
    () => licenseFSM.getGate().state + '|' + licenseFSM.getEntitlements().join(','),
  );
  return licenseFSM.hasEntitlement(key);
}

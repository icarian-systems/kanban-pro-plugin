/**
 * state.edges.test.ts — License FSM edge-case regressions.
 *
 * Two narrowly-scoped bugs:
 *
 *   1. `enterGrace` previously read `graceStartedAt = persisted.graceStartedAt || now()`.
 *       The `||` short-circuit treats `0` as "not in grace" and stamps the
 *       current clock — correct on the first transition, but every cold
 *       start that hit `enterGrace` would re-stamp the clock to "now" if
 *       the persisted value somehow round-tripped back to 0 (e.g. via a
 *       buggy revalidate path or a future schema migration). The contract
 *       is: once non-zero, frozen until a successful server response
 *       resets it. Test pins the freeze.
 *
 *   2. `revalidate` rotated-but-unknown-kid. Server returns
 *       `status: 'rotated'` with a new token. Previously the code only
 *       took the `if (v.ok)` branch and let `v.ok === false` fall through
 *       to the `status: 'ok'` block at the bottom, silently retaining
 *       the OLD token as if validated. The fix demotes to `lapsed`
 *       (clears persistence) and surfaces a `lastError`.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PUBLIC_KEYS } from '../keys';
import { base64urlEncode, bytesToHex } from '../verify';
import type { PersistedLicense } from '../state';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const TEST_KID = 'curr-2026';
let priv: Uint8Array;

// Mutable mock-response holders.
let mockValidateResponse: { status: 'ok' | 'revoked' | 'refunded' | 'rotated'; token?: string } = { status: 'ok' };
let validateThrows = false;

vi.mock('../remote', () => ({
  activate: vi.fn(async () => ({ token: '', exp: 0 })),
  validate: vi.fn(async () => {
    if (validateThrows) throw new Error('network down');
    return mockValidateResponse;
  }),
  fetchRevocations: vi.fn(async () => ({ revoked: [], cursor: 0 })),
  setLicenseServerBaseUrl: vi.fn(),
  getLicenseServerBaseUrl: () => 'http://test',
}));

import { LicenseFSMClass } from '../state';

async function signToken(payload: object, signingKey: Uint8Array = priv): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const payloadB64 = base64urlEncode(payloadBytes);
  const signed = new TextEncoder().encode(payloadB64);
  const sig = await ed.signAsync(signed, signingKey);
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const entry = PUBLIC_KEYS.find((k) => k.kid === TEST_KID);
  if (entry) {
    (entry as { publicKeyHex: string }).publicKeyHex = bytesToHex(pub);
  }
});

beforeEach(() => {
  mockValidateResponse = { status: 'ok' };
  validateThrows = false;
});

function makeFakePersistence(initial: PersistedLicense | null = null) {
  let store: PersistedLicense | null = initial;
  return {
    load: vi.fn(async () => store),
    save: vi.fn(async (p: PersistedLicense | null) => {
      store = p;
    }),
    get current() {
      return store;
    },
  };
}

describe('FSM enterGrace — graceStartedAt is stamped once and frozen', () => {
  it('an already-non-zero graceStartedAt is NOT reset on subsequent enterGrace calls', async () => {
    // Seed a token that's still inside its exp window but persistence
    // says we've been in grace since 10 days ago.
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 30 * 24 * 60 * 60;
    const token = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 10 * 24 * 60 * 60,
      exp,
    });
    const tenDaysAgoMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const persistence = makeFakePersistence({
      token,
      exp,
      lastValidatedAt: tenDaysAgoMs,
      graceStartedAt: tenDaysAgoMs,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();
    // Load saw a valid token, so we're back on `licensed` — but the
    // persisted graceStartedAt is still the 10-day-ago anchor. That's
    // the field we're protecting.

    // Force three failed revalidates (each invokes enterGrace internally).
    validateThrows = true;
    await fsm.revalidate();
    // Microtask drain for fire-and-forget persist.
    await Promise.resolve();
    await Promise.resolve();
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();

    // graceStartedAt MUST still equal the original anchor — not Date.now().
    expect(persistence.current?.graceStartedAt).toBe(tenDaysAgoMs);
  });

  it('a zero graceStartedAt is stamped to now() on first entry, then frozen', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 30 * 24 * 60 * 60;
    const token = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 60,
      exp,
    });
    const persistence = makeFakePersistence({
      token,
      exp,
      lastValidatedAt: Date.now(),
      graceStartedAt: 0,
      sub: 'user@example.com',
    });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();

    validateThrows = true;
    const stampFloor = Date.now();
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();
    const firstStamp = persistence.current?.graceStartedAt;
    expect(firstStamp).toBeGreaterThanOrEqual(stampFloor);

    // Second + third call must not move the anchor.
    await new Promise((r) => setTimeout(r, 5));
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.current?.graceStartedAt).toBe(firstStamp);
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.current?.graceStartedAt).toBe(firstStamp);
  });
});

describe('FSM revalidate — rotated response with unknown-kid', () => {
  it('demotes to lapsed and clears persistence when the rotated token fails client verification', async () => {
    // Seed a valid, currently-licensed FSM.
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 30 * 24 * 60 * 60;
    const goodToken = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 60,
      exp,
    });
    const persistence = makeFakePersistence({
      token: goodToken,
      exp,
      lastValidatedAt: Date.now() - 1000,
      graceStartedAt: 0,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();
    expect(fsm.getGate().state).toBe('licensed');

    // Server says rotated — but it minted the new token with a kid we
    // don't ship. Could happen if the server is upgraded ahead of the
    // plugin, or if a key rotation hasn't propagated yet.
    const badToken = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: 'not-a-real-kid-2099',
      iat: now,
      exp,
    });
    mockValidateResponse = { status: 'rotated', token: badToken };
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();

    // The contract: gate is demoted to free·lapsed, persistence is
    // cleared, and a lastError was attached so the Pro pane can show
    // the user what happened. The OLD token MUST NOT be retained as
    // if the response had been status: 'ok' — that was the silent-fall-
    // through bug we're regressing against.
    const gate = fsm.getGate();
    expect(gate.tier).toBe('free');
    expect(gate.state).toBe('lapsed');
    expect(persistence.current).toBeNull();
    // lastError is optional on ProGate; presence is required here.
    const withError = gate as typeof gate & { lastError?: { message: string } };
    expect(withError.lastError?.message).toBeTruthy();
  });

  it('rotated response with a verifier-valid new-token rotates persistence in place (regression baseline)', async () => {
    // Sanity baseline: when the rotated path's token DOES verify, we
    // accept it and swap the persisted record. This is the happy path
    // we must not break with this fix.
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 30 * 24 * 60 * 60;
    const oldToken = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 1000,
      exp: exp - 100,
    });
    const newToken = await signToken({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now,
      exp,
      entitlements: ['recurrence', 'savedViews'],
    });
    const persistence = makeFakePersistence({
      token: oldToken,
      exp: exp - 100,
      lastValidatedAt: Date.now() - 1000,
      graceStartedAt: 0,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();
    expect(fsm.getGate().state).toBe('licensed');

    mockValidateResponse = { status: 'rotated', token: newToken };
    await fsm.revalidate();
    await Promise.resolve();
    await Promise.resolve();

    expect(fsm.getGate().state).toBe('licensed');
    expect(persistence.current?.token).toBe(newToken);
    expect(persistence.current?.entitlements).toContain('savedViews');
  });
});

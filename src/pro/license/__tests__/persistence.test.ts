/**
 * persistence.test.ts — License FSM persistence contract.
 *
 * Regression: after `Activate`, `data.json` contained the RAW activation
 * input (`email|key`) instead of the server-signed token. After a plugin
 * off/on cycle, the FSM landed back in `Unlicensed` because there was
 * nothing offline-verifiable in storage. The 30-day grace period depends
 * on the cold-start re-hydration working.
 *
 * Contract under test:
 *
 *   1. `licenseFSM.activate(...)` MUST route the signed token through the
 *      attached `LicensePersistence.save(p)` — `p.token` is the server-
 *      signed token, NOT the raw `email|key` input.
 *   2. `licenseFSM.load()` against the same persistence MUST bring the
 *      gate back up to `pro · licensed` for a cached, non-expired token —
 *      the cold-start auto-activation path.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PUBLIC_KEYS } from '../keys';
import { base64urlEncode, bytesToHex } from '../verify';

// Wire @noble/ed25519's hash hook (the verify.ts hook only fires when the
// production module is imported; tests sign fresh tokens so they need the
// hook locally too).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const TEST_KID = 'curr-2026';
let priv: Uint8Array;

// Holders for the mocked remote responses. Tests mutate these before
// invoking the FSM. Because vi.mock is hoisted, the factory below
// references these names through the closure rebound when the factory
// actually runs (after `beforeAll` populates them).
let mockActivateResponse: { token: string; exp: number } = { token: '', exp: 0 };

// Mutable validate-response holder so Grace-path tests can flip the mock
// between `ok`, throw (network failure), and `revoked` for the same FSM.
let mockValidateResponse:
  | { kind: 'ok' }
  | { kind: 'throw' }
  | { kind: 'revoked' } = { kind: 'ok' };

vi.mock('../remote', () => ({
  activate: vi.fn(async () => mockActivateResponse),
  validate: vi.fn(async () => {
    if (mockValidateResponse.kind === 'throw') {
      throw new Error('simulated network failure');
    }
    if (mockValidateResponse.kind === 'revoked') {
      return { status: 'revoked' as const };
    }
    return { status: 'ok' as const };
  }),
  fetchRevocations: vi.fn(async () => ({ revoked: [], cursor: 0 })),
  setLicenseServerBaseUrl: vi.fn(),
  getLicenseServerBaseUrl: () => 'http://test',
}));

// Import the FSM AFTER the mock is registered. Vitest hoists `vi.mock`
// above all imports, but we want this import to be unambiguous — the
// production module pulls `remote` via `import { activate as remoteActivate }`
// and that binding will resolve to our mock.
import { LicenseFSMClass, type PersistedLicense } from '../state';

async function signToken(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const payloadB64 = base64urlEncode(payloadBytes);
  const signed = new TextEncoder().encode(payloadB64);
  const sig = await ed.signAsync(signed, priv);
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  // Patch the bundled keys.ts entry so `verifyToken` will accept our
  // freshly-signed tokens.
  const entry = PUBLIC_KEYS.find((k) => k.kid === TEST_KID);
  if (entry) {
    (entry as { publicKeyHex: string }).publicKeyHex = bytesToHex(pub);
  }
});

/** A fake `LicensePersistence` we can introspect. */
function makeFakePersistence(initial: PersistedLicense | null = null) {
  let store: PersistedLicense | null = initial;
  const saves: Array<PersistedLicense | null> = [];
  return {
    load: vi.fn(async () => store),
    save: vi.fn(async (p: PersistedLicense | null) => {
      store = p;
      saves.push(p);
    }),
    /** Test introspection. */
    get current(): PersistedLicense | null {
      return store;
    },
    saves,
  };
}

/** Sign a token with our test key + populate the mocked `remoteActivate`. */
async function primeSignedActivateResponse(sub: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 365 * 24 * 60 * 60;
  const token = await signToken({
    sub,
    tier: 'pro',
    kid: TEST_KID,
    iat: now,
    exp,
    entitlements: ['recurrence', 'savedViews'],
  });
  mockActivateResponse = { token, exp };
  return mockActivateResponse;
}

describe('license FSM — persistence (signed token round-trips through save/load)', () => {
  it('activate persists the SIGNED token, not the raw email|key input', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const fsm = new LicenseFSMClass();
    const persistence = makeFakePersistence();
    fsm.attachPersistence(persistence);

    const gate = await fsm.activate({ email: 'user@example.com', key: 'kbn_xxxx' });
    expect(gate.tier).toBe('pro');
    expect(gate.state).toBe('licensed');

    // The raw `email|key` should NEVER be what we persisted. The token has
    // a `.` separator (payload.signature) and is much longer than `email|key`.
    expect(persistence.current).not.toBeNull();
    expect(persistence.current?.token).toBe(signed.token);
    expect(persistence.current?.token).not.toBe('user@example.com|kbn_xxxx');
    expect(persistence.current?.token).toContain('.');
    expect(persistence.current?.lastValidatedAt).toBeGreaterThan(0);
    expect(persistence.current?.sub).toBe('user@example.com');
    // Persistence got called exactly once for the successful activation.
    expect(persistence.save).toHaveBeenCalled();
  });

  it('a fresh FSM with the same persistence restores Pro · licensed at boot (cold-start auto-activation)', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const now = Date.now();
    // Seed the persistence with what an earlier activation would have written.
    const persistence = makeFakePersistence({
      token: signed.token,
      exp: signed.exp,
      lastValidatedAt: now,
      graceStartedAt: 0,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });

    // Simulate a plugin off/on: fresh FSM, same persistence.
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();

    const gate = fsm.getGate();
    expect(gate.tier).toBe('pro');
    expect(gate.state).toBe('licensed');
    // Entitlements survive the round-trip.
    expect(fsm.hasEntitlement('recurrence')).toBe(true);
  });

  it('a fresh FSM with no persistence stays Unlicensed (no false-positive on empty data.json)', async () => {
    const persistence = makeFakePersistence(null);
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(persistence);
    await fsm.load();

    const gate = fsm.getGate();
    expect(gate.tier).toBe('free');
    expect(gate.state).toBe('unlicensed');
  });

  it('revalidate failure transitions Licensed → Grace and keeps entitlements live', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const fsm = new LicenseFSMClass();
    const persistence = makeFakePersistence({
      token: signed.token,
      exp: signed.exp,
      lastValidatedAt: Date.now(),
      graceStartedAt: 0,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });
    fsm.attachPersistence(persistence);
    await fsm.load();
    expect(fsm.getGate().state).toBe('licensed');

    // Server unreachable: revalidate throws → enterGrace.
    mockValidateResponse = { kind: 'throw' };
    await fsm.revalidate();

    expect(fsm.getGate().tier).toBe('pro');
    expect(fsm.getGate().state).toBe('grace');
    // Pro entitlements still flow during Grace — that's the whole point
    // of the 30-day offline-tolerance contract.
    expect(fsm.hasEntitlement('recurrence')).toBe(true);

    // Restore reachability on the next revalidate → Grace → Licensed.
    mockValidateResponse = { kind: 'ok' };
    await fsm.revalidate();
    expect(fsm.getGate().state).toBe('licensed');
  });

  it('Grace expires to Lapsed once 30d + token-exp both elapse', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const fsm = new LicenseFSMClass();
    // Mount a clock we can move forward.
    let now = Date.now();
    fsm.setClock(() => now);

    const persistence = makeFakePersistence({
      token: signed.token,
      // Force token exp into the recent past so the Grace expiry check
      // (`exp * 1000 < now`) flips true once we advance the clock past
      // GRACE_PERIOD_MS. Without this the FSM stays in grace indefinitely
      // because the cached token is still cryptographically valid.
      exp: Math.floor((now - 1_000) / 1000),
      lastValidatedAt: now,
      graceStartedAt: 0,
      sub: 'user@example.com',
      entitlements: ['recurrence'],
    });
    fsm.attachPersistence(persistence);
    await fsm.load();

    // First failure starts the grace clock.
    mockValidateResponse = { kind: 'throw' };
    await fsm.revalidate();
    expect(fsm.getGate().state).toBe('grace');

    // Advance the clock past the 30-day window.
    now += 31 * 24 * 60 * 60 * 1000;
    await fsm.revalidate();

    expect(fsm.getGate().tier).toBe('free');
    expect(fsm.getGate().state).toBe('lapsed');
    // Pro entitlements gate off after lapse.
    expect(fsm.hasEntitlement('recurrence')).toBe(false);
  });

  it('deactivate clears the persisted record', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const fsm = new LicenseFSMClass();
    const persistence = makeFakePersistence({
      token: signed.token,
      exp: signed.exp,
      lastValidatedAt: Date.now(),
      graceStartedAt: 0,
      sub: 'user@example.com',
    });
    fsm.attachPersistence(persistence);
    await fsm.load();
    expect(fsm.getGate().tier).toBe('pro');

    await fsm.deactivate();
    // Wait a microtask for fire-and-forget persist.
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.current).toBeNull();
    expect(fsm.getGate().tier).toBe('free');
    expect(fsm.getGate().state).toBe('unlicensed');
  });
});

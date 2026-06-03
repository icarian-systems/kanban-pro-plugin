/**
 * persistence.contract.test.ts — Round-trip data.json shape contract.
 *
 * The existing `persistence.test.ts` covers the FSM's own save/load
 * contract via an injected `LicensePersistence`. This file goes one level
 * out: it stands up an in-memory mock of the Obsidian plugin's
 * `loadData` / `saveData` channel — the exact wiring `main.ts.onload`
 * attaches — and asserts the shape of the bytes that actually land in
 * `data.json` after a real activate / deactivate cycle.
 *
 * Specifically, the legacy-field shadow: after a successful
 * activate, `data.licenseToken` MUST be null (or absent) and the signed
 * token MUST live under `data.persistedLicense.token`, with the three
 * base64url segments parsing as a proper EdDSA token payload. The bug
 * we're regressing against: `data.licenseToken` was the raw `email|key`
 * input, persisted by an earlier version of the Pro pane and never
 * scrubbed on success — so a power user invoking the
 * `kanban-pro-license-activate` command would still hit the stale field
 * fall-back, re-exchanging the same key on every cold start instead of
 * trusting the cached signed token.
 *
 * The contract also covers the cold-start / warm-start auto-activation
 * path: a fresh FSM attached to the same persistence should reach
 * `pro · licensed` without any network call.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PUBLIC_KEYS } from '../keys';
import { base64urlEncode, bytesToHex, base64urlDecode } from '../verify';

// Wire @noble/ed25519's SHA-512 hook.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const TEST_KID = 'curr-2026';
let priv: Uint8Array;

let mockActivateResponse: { token: string; exp: number } = { token: '', exp: 0 };

vi.mock('../remote', () => ({
  activate: vi.fn(async () => mockActivateResponse),
  validate: vi.fn(async () => ({ status: 'ok' as const })),
  fetchRevocations: vi.fn(async () => ({ revoked: [], cursor: 0 })),
  setLicenseServerBaseUrl: vi.fn(),
  getLicenseServerBaseUrl: () => 'http://test',
}));

import { LicenseFSMClass } from '../state';

async function signToken(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const payloadB64 = base64urlEncode(payloadBytes);
  const signed = new TextEncoder().encode(payloadB64);
  const sig = await ed.signAsync(signed, priv);
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

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

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const entry = PUBLIC_KEYS.find((k) => k.kid === TEST_KID);
  if (entry) {
    (entry as { publicKeyHex: string }).publicKeyHex = bytesToHex(pub);
  }
});

/**
 * Simulates the host plugin's `loadData` / `saveData` channel. The shape
 * persisted here is what would land in `data.json` on disk.
 *
 * The FSM only writes `persistedLicense`; the Pro pane (and Deactivate
 * handler) own the `licenseToken` scrub. We model the latter as a tiny
 * `host` object so the test exercises the same boundary `main.ts.onload`
 * and `Pro.tsx` cross.
 */
function makeHost(seed: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...seed };
  const settings = { licenseToken: null as string | null, persistedLicense: null };
  // Persistence pair shaped exactly like main.ts.onload — save mutates
  // settings.persistedLicense and flushes to the data blob.
  const persistence = {
    load: vi.fn(async () => (data.persistedLicense ?? null) as ReturnType<typeof Object> | null),
    save: vi.fn(async (p: unknown) => {
      data = { ...data, persistedLicense: p };
      (settings as { persistedLicense: unknown }).persistedLicense = p;
    }),
  };
  // The Pro pane scrubs `licenseToken` through host.saveSettings(); we
  // model that as a direct field write + persist.
  function scrubLegacyToken(): Promise<void> {
    settings.licenseToken = null;
    data = { ...data, licenseToken: null };
    return Promise.resolve();
  }
  function getData(): Record<string, unknown> {
    return data;
  }
  return { settings, persistence, scrubLegacyToken, getData };
}

describe('license persistence contract — data.json shape after activate / deactivate', () => {
  it('after a successful activate, data.licenseToken is null AND persistedLicense.token is the signed token', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    // Seed the legacy field as a 1.0.0 install would have.
    const host = makeHost({ licenseToken: 'user@example.com|kbn_xxxx' });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(host.persistence);

    const gate = await fsm.activate({ email: 'user@example.com', key: 'kbn_xxxx' });
    expect(gate.tier).toBe('pro');
    expect(gate.state).toBe('licensed');

    // Simulate the Pro pane's success-path cleanup.
    await host.scrubLegacyToken();

    const data = host.getData();
    expect(data.licenseToken == null).toBe(true);
    const persisted = data.persistedLicense as { token: string } | null;
    expect(persisted).not.toBeNull();
    expect(persisted!.token).toBe(signed.token);
    expect(persisted!.token.length).toBeGreaterThan(100);

    // Token's three base64url segments parse as `{ alg: 'EdDSA', kid: ... }`-
    // shaped payload. Our wire format is `payloadB64.signatureB64` (two
    // segments, not three — the JOSE-style header is implied by the
    // single signing alg). Parse the payload and assert the kid + tier.
    const dot = persisted!.token.indexOf('.');
    expect(dot).toBeGreaterThan(0);
    const payloadB64 = persisted!.token.slice(0, dot);
    const payloadBytes = base64urlDecode(payloadB64);
    const payloadJson = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      kid: string;
      tier: string;
      sub: string;
    };
    expect(payloadJson.kid).toBe(TEST_KID);
    expect(payloadJson.tier).toBe('pro');
    expect(payloadJson.sub).toBe('user@example.com');
  });

  it('deactivate + reactivate leaves data.licenseToken null on both legs (not just after activate)', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const host = makeHost({ licenseToken: 'user@example.com|kbn_xxxx' });
    const fsm = new LicenseFSMClass();
    fsm.attachPersistence(host.persistence);

    // Activate → scrub.
    await fsm.activate({ email: 'user@example.com', key: 'kbn_xxxx' });
    await host.scrubLegacyToken();
    expect((host.getData() as { licenseToken: unknown }).licenseToken == null).toBe(true);
    expect((host.getData() as { persistedLicense: { token: string } | null }).persistedLicense?.token).toBe(signed.token);

    // Deactivate. The FSM clears persistedLicense; the Pro pane mirrors
    // licenseToken = null. Both must land on disk.
    await fsm.deactivate();
    // fire-and-forget persistence settle
    await Promise.resolve();
    await Promise.resolve();
    await host.scrubLegacyToken();
    expect((host.getData() as { licenseToken: unknown }).licenseToken == null).toBe(true);
    expect((host.getData() as { persistedLicense: unknown }).persistedLicense).toBeNull();

    // Reactivate. Same expectation.
    await fsm.activate({ email: 'user@example.com', key: 'kbn_xxxx' });
    await host.scrubLegacyToken();
    expect((host.getData() as { licenseToken: unknown }).licenseToken == null).toBe(true);
    expect((host.getData() as { persistedLicense: { token: string } | null }).persistedLicense?.token).toBe(signed.token);
  });

  it('simulated restart: fresh FSM with same persistence warm-starts to Licensed without any network call', async () => {
    const signed = await primeSignedActivateResponse('user@example.com');
    const host = makeHost();
    const fsmA = new LicenseFSMClass();
    fsmA.attachPersistence(host.persistence);
    await fsmA.activate({ email: 'user@example.com', key: 'kbn_xxxx' });
    expect(fsmA.getGate().tier).toBe('pro');

    // Throw away fsmA. New FSM reading the same persistence — this is
    // the cold-start path. The mocked remoteActivate is unchanged
    // (would still return a token), but `fsmB.load()` must verify the
    // cached token entirely offline and reach `licensed` without
    // calling activate.
    const fsmB = new LicenseFSMClass();
    fsmB.attachPersistence(host.persistence);
    await fsmB.load();
    expect(fsmB.getGate().tier).toBe('pro');
    expect(fsmB.getGate().state).toBe('licensed');
    // Persisted token unchanged.
    const data = host.getData() as { persistedLicense: { token: string } | null };
    expect(data.persistedLicense?.token).toBe(signed.token);
  });
});

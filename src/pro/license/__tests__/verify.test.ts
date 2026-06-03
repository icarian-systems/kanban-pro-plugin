/**
 * Golden token tests. We construct signed tokens against a known key
 * and verify the cases (valid / expired / tampered / wrong-kid).
 *
 * The bundled keys.ts ships placeholder all-zero pubkeys. For these
 * tests we patch the keys module at runtime with a real keypair.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll } from 'vitest';
import { base64urlEncode, bytesToHex, verifyToken } from '../verify';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// We override keys.ts at module level. vi.mock would also work but
// keeping it explicit makes the test easier to reason about.
import { PUBLIC_KEYS } from '../keys';

let priv: Uint8Array;
let pub: Uint8Array;
const TEST_KID = 'curr-2026';

async function sign(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const payloadB64 = base64urlEncode(payloadBytes);
  const signed = new TextEncoder().encode(payloadB64);
  const sig = await ed.signAsync(signed, priv);
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  pub = await ed.getPublicKeyAsync(priv);
  // Patch in our test pubkey under TEST_KID.
  const entry = PUBLIC_KEYS.find((k) => k.kid === TEST_KID);
  if (entry) {
    (entry as { publicKeyHex: string }).publicKeyHex = bytesToHex(pub);
  }
});

describe('verifyToken', () => {
  it('accepts a valid token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 60,
      exp: now + 3600,
      entitlements: ['recurrence', 'savedViews'],
    });
    const r = await verifyToken(tok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sub).toBe('user@example.com');
      expect(r.payload.entitlements).toContain('recurrence');
    }
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({
      sub: 'a@b.c',
      tier: 'pro',
      kid: TEST_KID,
      iat: now - 7200,
      exp: now - 3600,
    });
    const r = await verifyToken(tok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('rejects a tampered payload', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({
      sub: 'user@example.com',
      tier: 'pro',
      kid: TEST_KID,
      iat: now,
      exp: now + 3600,
    });
    // Flip one character in the payload section.
    const dot = tok.indexOf('.');
    const tampered = tok.slice(0, 4) + (tok[4] === 'A' ? 'B' : 'A') + tok.slice(5, dot) + tok.slice(dot);
    const r = await verifyToken(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Could be bad-base64, bad-json, bad-payload-shape, or bad-signature
      // depending on which byte changed — all are valid rejections.
      expect(['bad-base64', 'bad-json', 'bad-payload-shape', 'bad-signature']).toContain(r.reason);
    }
  });

  it('rejects unknown kid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({
      sub: 'a@b.c',
      tier: 'pro',
      kid: 'totally-unknown-kid',
      iat: now,
      exp: now + 3600,
    });
    const r = await verifyToken(tok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-kid');
  });

  it('rejects malformed token', async () => {
    const r = await verifyToken('not-a-token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects empty string', async () => {
    const r = await verifyToken('');
    expect(r.ok).toBe(false);
  });

  it('rejects bad-shape payload', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await sign({
      // Missing required fields.
      sub: 'x',
      tier: 'free',
      iat: now,
      exp: now + 3600,
    });
    const r = await verifyToken(tok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-payload-shape');
  });
});
